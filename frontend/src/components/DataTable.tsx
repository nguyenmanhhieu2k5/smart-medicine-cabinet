import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/Button";
import { useT } from "@/i18n";

export interface Column<T> {
  key: string;
  header: string;
  width?: string; // giá trị CSS grid: "2fr", "140px"…
  align?: "left" | "right" | "center";
  render: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  empty?: ReactNode;
  rowClassName?: (row: T) => string | undefined;
  footer?: ReactNode;
}

/** Bảng dữ liệu nhẹ: tiêu đề nhỏ, hàng thoáng, không kẻ ô dày đặc. */
export function DataTable<T>({ columns, rows, rowKey, onRowClick, loading = false, empty, rowClassName, footer }: DataTableProps<T>) {
  const template = columns.map((c) => c.width ?? "1fr").join(" ");
  const alignClass = (align?: string) => (align === "right" ? "justify-end text-right" : align === "center" ? "justify-center text-center" : "");
  return (
    <div role="table" className="w-full">
      <div role="row" className="grid items-center gap-4 border-b border-line px-5 pb-3.5 text-[13px] font-semibold text-muted" style={{ gridTemplateColumns: template }}>
        {columns.map((column) => (
          <div role="columnheader" key={column.key} className={clsx("flex", alignClass(column.align))}>{column.header}</div>
        ))}
      </div>
      {loading ? (
        <div className="space-y-1 pt-2" role="status" aria-label="Đang tải">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="grid items-center gap-4 px-5 py-4" style={{ gridTemplateColumns: template }}>
              {columns.map((column, col) => (
                <div key={column.key} className="skeleton h-4" style={{ width: col === 0 ? "70%" : "55%" }} />
              ))}
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        empty
      ) : (
        <div>
          {rows.map((row) => (
            <div
              role="row" key={rowKey(row)} tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={onRowClick ? (event) => { if (event.key === "Enter") onRowClick(row); } : undefined}
              className={clsx(
                "grid min-h-[72px] items-center gap-4 border-b border-line px-5 py-3 text-sm transition-colors duration-150 last:border-b-0",
                onRowClick && "cursor-pointer hover:bg-tile/70",
                rowClassName?.(row),
              )}
              style={{ gridTemplateColumns: template }}
            >
              {columns.map((column) => (
                <div role="cell" key={column.key} className={clsx("flex min-w-0 items-center", alignClass(column.align))}>{column.render(row)}</div>
              ))}
            </div>
          ))}
        </div>
      )}
      {footer}
    </div>
  );
}

export function Pagination({ page, pages, total, onChange, label }: { page: number; pages: number; total: number; onChange: (page: number) => void; label?: string }) {
  const t = useT();
  if (total === 0) return null;
  return (
    <div className="mt-3 flex items-center justify-between border-t border-line px-5 pt-4 text-[13px] text-muted">
      <span>{label ?? t("{total} mục", { total })}</span>
      <div className="flex items-center gap-2">
        <IconButton icon={ChevronLeft} label={t("Trang trước")} size="sm" disabled={page <= 1} onClick={() => onChange(page - 1)} />
        <span className="min-w-16 text-center tabular-nums">{t("Trang {page}/{pages}", { page, pages })}</span>
        <IconButton icon={ChevronRight} label={t("Trang sau")} size="sm" disabled={page >= pages} onClick={() => onChange(page + 1)} />
      </div>
    </div>
  );
}
