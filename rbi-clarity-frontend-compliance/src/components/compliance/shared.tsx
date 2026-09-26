import type { ReactNode } from "react";
import { AlertCircle, Loader2, RotateCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { statusClass, statusLabel } from "@/lib/compliance";

export const StatusBadge = ({ status, className }: { status: string; className?: string }) => (
  <Badge variant="outline" className={cn("text-xs whitespace-nowrap", statusClass(status), className)}>
    {statusLabel(status)}
  </Badge>
);

export const LoadingState = ({ label = "Loading…" }: { label?: string }) => (
  <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground" role="status">
    <Loader2 className="h-5 w-5 animate-spin" />
    {label}
  </div>
);

export const ErrorState = ({
  message,
  onRetry,
  retrying,
  compact,
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
  compact?: boolean;
}) => (
  <div
    role="alert"
    className={cn(
      "flex flex-col sm:flex-row sm:items-center gap-3 rounded-lg border border-destructive/30 bg-red-50 text-sm",
      compact ? "p-3" : "p-4",
    )}
  >
    <div className="flex items-start gap-2 flex-1 min-w-0">
      <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
      <p className="text-foreground break-words">{message}</p>
    </div>
    {onRetry && (
      <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying} className="shrink-0 bg-card">
        {retrying ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RotateCw className="h-3.5 w-3.5 mr-1.5" />}
        Retry
      </Button>
    )}
  </div>
);

export const EmptyState = ({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) => (
  <div className="flex flex-col items-center text-center py-10 px-4">
    {icon && <div className="mb-3 rounded-lg bg-muted p-2.5 text-primary">{icon}</div>}
    <p className="text-sm font-medium text-foreground">{title}</p>
    {description && <p className="text-sm text-muted-foreground mt-1 max-w-md">{description}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);

export const SectionHeading = ({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) => (
  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
    <div className="min-w-0">
      <h3 className="font-semibold text-foreground">{title}</h3>
      {description && <p className="text-sm text-muted-foreground mt-0.5">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap gap-2 shrink-0">{actions}</div>}
  </div>
);
