import { ExternalLink } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatDate,
  useHydratedTimeZone,
} from "@/lib/hydration-safe-datetime";

export interface InvoiceRow {
  id: string;
  createdAtMs: number;
  totalCents: number;
  currency: string;
  status: string;
  hostedInvoiceUrl: string | null;
}

interface InvoicesTableProps {
  invoices: InvoiceRow[];
}

function formatStatus(status: string): string {
  if (!status) return "";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatAmount(amountCents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency || "usd").toUpperCase(),
  }).format(amountCents / 100);
}

export function InvoicesTable({ invoices }: InvoicesTableProps) {
  const timeZone = useHydratedTimeZone();

  if (invoices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No invoices yet.</p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Total</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoices.map((invoice) => (
          <TableRow key={invoice.id}>
            <TableCell>
              {formatDate(invoice.createdAtMs, timeZone)}
            </TableCell>
            <TableCell>
              {formatAmount(invoice.totalCents, invoice.currency)}
            </TableCell>
            <TableCell>{formatStatus(invoice.status)}</TableCell>
            <TableCell className="text-right">
              {invoice.hostedInvoiceUrl ? (
                <a
                  href={invoice.hostedInvoiceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  View
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
