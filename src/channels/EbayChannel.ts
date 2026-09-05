/**
 * EbayChannel — SalesChannel implementation wrapping the existing EbayClient.
 *
 * This is a thin adapter: it translates the generic SalesChannel interface
 * shapes into the eBay-specific calls already implemented in EbayClient.
 * All real eBay logic (OAuth, retry, rate-limiting) stays in EbayClient —
 * this class only handles the shape translation.
 *
 * Why a wrapper instead of replacing EbayClient?
 *   The existing sync loop, order routing loop, fulfillment loop, and the
 *   auto-listing pipeline (autoListingService.ts) all call EbayClient
 *   directly. Replacing them all in one shot would be too wide a change.
 *   Instead, EbayChannel lets NEW code (and future refactors) talk to eBay
 *   through the SalesChannel interface while the legacy job code continues
 *   to use EbayClient unchanged. Over time, job loops can be migrated one
 *   at a time to the channel abstraction.
 *
 * eBay-specific fields (merchantLocationKey, marketplaceId) are passed via
 * ChannelListingParams.extra so they don't pollute the interface.
 */
import {
  SalesChannel,
  ChannelListingParams,
  ChannelListingResult,
  ChannelPriceStockUpdate,
  ChannelOrder,
  ChannelShipmentParams,
} from "./SalesChannel";
import { EbayClient } from "../ebay/ebayClient";
import { logger } from "../logger";

export class EbayChannel implements SalesChannel {
  readonly channelKey = "EBAY";

  constructor(private client: EbayClient) {}

  // ── createOrUpdateListing ────────────────────────────────────────────────

  async createOrUpdateListing(params: ChannelListingParams): Promise<ChannelListingResult> {
    const merchantLocationKey =
      (params.extra?.merchantLocationKey as string | undefined) ?? "";
    const marketplaceId =
      (params.extra?.marketplaceId as string | undefined) ?? "EBAY_US";

    // Step 1: create / replace inventory item
    await this.client.createOrReplaceInventoryItem({
      sku:        params.channelSku,
      title:      params.title,
      description: params.description,
      quantity:   params.quantity,
      imageUrls:  params.imageUrls,
      condition:  params.condition,
    });

    // Step 2: create offer
    const { offerId } = await this.client.createOffer({
      sku:                params.channelSku,
      marketplaceId,
      price:              params.price,
      currency:           params.currency,
      categoryId:         params.categoryId,
      quantity:           params.quantity,
      merchantLocationKey,
      listingDescription: params.description,
    });

    // Step 3: publish offer → get eBay listing ID
    const { listingId } = await this.client.publishOffer(offerId);

    logger.info("EbayChannel: listing created/updated", {
      channelSku: params.channelSku,
      offerId,
      listingId,
    });

    return { channelListingId: listingId, channelSku: params.channelSku };
  }

  // ── bulkUpdatePriceStock ─────────────────────────────────────────────────

  async bulkUpdatePriceStock(updates: ChannelPriceStockUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    // eBay allows max 25 per bulkUpdatePriceQuantity call — chunk internally
    for (let i = 0; i < updates.length; i += 25) {
      const chunk = updates.slice(i, i + 25);
      await this.client.bulkUpdatePriceQuantity(
        chunk.map((u) => ({
          sku:      u.channelSku,
          price:    u.price,
          currency: u.currency,
          quantity: u.quantity,
        }))
      );
    }

    logger.info("EbayChannel: bulk price/stock updated", { count: updates.length });
  }

  // ── getPaidOrders ────────────────────────────────────────────────────────

  async getPaidOrders(sinceIso?: string): Promise<ChannelOrder[]> {
    const ebayOrders = await this.client.getNewPaidOrders(sinceIso);

    return ebayOrders.map((o) => ({
      channelOrderId:    o.orderId,
      fulfillmentStatus: o.orderFulfillmentStatus,
      paymentStatus:     o.orderPaymentStatus,
      buyer:             { username: o.buyer?.username },
      lineItems:         o.lineItems.map((li) => ({
        lineItemId: li.lineItemId,
        channelSku: li.sku,
        quantity:   li.quantity,
      })),
      shippingAddress: {
        fullName:    o.shippingAddress.fullName,
        line1:       o.shippingAddress.addressLine1,
        line2:       o.shippingAddress.addressLine2,
        city:        o.shippingAddress.city,
        state:       o.shippingAddress.stateOrProvince,
        postalCode:  o.shippingAddress.postalCode,
        countryCode: o.shippingAddress.countryCode,
        phone:       o.shippingAddress.phoneNumber,
      },
      raw: o.raw,
    }));
  }

  // ── markShipped ──────────────────────────────────────────────────────────

  async markShipped(params: ChannelShipmentParams): Promise<void> {
    await this.client.createShippingFulfillment({
      orderId:             params.channelOrderId,
      lineItemId:          params.lineItemId,
      quantity:            params.quantity,
      trackingNumber:      params.trackingNumber,
      shippingCarrierCode: params.carrierCode,
      shippedDate:         params.shippedDate,
    });

    logger.info("EbayChannel: shipment marked", {
      orderId:        params.channelOrderId,
      trackingNumber: params.trackingNumber,
      carrier:        params.carrierCode,
    });
  }

  // ── testConnection ───────────────────────────────────────────────────────

  async testConnection(): Promise<true> {
    // Fetch at most 1 order — a minimal authenticated read to verify credentials.
    // Doesn't matter if the result is empty; a 200 proves the token works.
    await this.client.getNewPaidOrders(new Date(0).toISOString());
    return true;
  }
}
