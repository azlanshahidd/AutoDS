import { LucideIcon } from "lucide-react";

export function EmptyState({ icon: Icon, title, description, action }: {
  icon: LucideIcon; title: string; description?: string; action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-bg">
        <Icon size={24} className="text-cyan" strokeWidth={1.5} />
      </div>
      <div>
        <p className="text-sm font-semibold text-ink-2">{title}</p>
        {description && <p className="mt-1 max-w-xs text-sm text-ink-4">{description}</p>}
      </div>
      {action}
    </div>
  );
}
