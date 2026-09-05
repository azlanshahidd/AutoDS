/**
 * Suppliers REST routes.
 *
 * Fixes applied:
 *  P2-001 — parseIntId guard on every :id route
 *  P2-023 — DELETE returns 409 when variants still reference the supplier
 */
import { Router, Request, Response } from "express";
import {
  SuppliersService,
  AVAILABLE_SUPPLIER_PLUGINS,
  UnsupportedSupplierPluginError,
  SupplierNotFoundError,
} from "../services/suppliersService";
import { logger } from "../logger";

function parseIntId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function handleKnownErrors(err: unknown, res: Response): boolean {
  if (err instanceof UnsupportedSupplierPluginError) {
    res.status(400).json({ error: (err as Error).message });
    return true;
  }
  if (err instanceof SupplierNotFoundError) {
    res.status(404).json({ error: (err as Error).message });
    return true;
  }
  return false;
}

export function suppliersRouter(suppliersService: SuppliersService): Router {
  const router = Router();

  router.get("/available-plugins", (_req: Request, res: Response) => {
    res.json({ plugins: AVAILABLE_SUPPLIER_PLUGINS });
  });

  router.get("/", (_req: Request, res: Response) => {
    res.json({ suppliers: suppliersService.list() });
  });

  router.post("/", async (req: Request, res: Response) => {
    const { supplierKey, displayName, apiKey, apiSecret } = req.body || {};
    if (!supplierKey || !apiKey) {
      return res.status(400).json({ error: "supplierKey and apiKey are required." });
    }
    try {
      const supplier = await suppliersService.addSupplier({ supplierKey, displayName, apiKey, apiSecret });
      res.status(201).json({ supplier });
    } catch (err) {
      if (handleKnownErrors(err, res)) return;
      logger.error("Failed to add supplier", { error: (err as Error).message });
      res.status(500).json({ error: "Failed to add supplier." });
    }
  });

  router.patch("/:id", async (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    const { displayName, apiKey, apiSecret } = req.body || {};
    try {
      const supplier = await suppliersService.editSupplier(id, { displayName, apiKey, apiSecret });
      res.json({ supplier });
    } catch (err) {
      if (handleKnownErrors(err, res)) return;
      logger.error("Failed to edit supplier", { error: (err as Error).message, id });
      res.status(500).json({ error: "Failed to edit supplier." });
    }
  });

  router.post("/:id/test-connection", async (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    try {
      const supplier = await suppliersService.testConnection(id);
      res.json({ supplier });
    } catch (err) {
      if (handleKnownErrors(err, res)) return;
      logger.error("Failed to test supplier connection", { error: (err as Error).message, id });
      res.status(500).json({ error: "Failed to test connection." });
    }
  });

  router.patch("/:id/enabled", (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "Body must include boolean 'enabled'." });
    }
    try {
      const supplier = suppliersService.setEnabled(id, enabled);
      res.json({ supplier });
    } catch (err) {
      if (handleKnownErrors(err, res)) return;
      logger.error("Failed to toggle supplier", { error: (err as Error).message, id });
      res.status(500).json({ error: "Failed to update supplier." });
    }
  });

  router.delete("/:id", (req: Request, res: Response) => {
    const id = parseIntId(req.params.id);
    if (id === null) return res.status(400).json({ error: "id must be a positive integer." });

    try {
      suppliersService.remove(id);
      res.status(204).send();
    } catch (err) {
      if (handleKnownErrors(err, res)) return;
      // P2-023: variant conflict — use 409
      const msg = (err as Error).message ?? "";
      if (msg.includes("variant(s) still reference")) {
        return res.status(409).json({ error: msg });
      }
      logger.error("Failed to remove supplier", { error: msg, id });
      res.status(500).json({ error: "Failed to remove supplier." });
    }
  });

  return router;
}
