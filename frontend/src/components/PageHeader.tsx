import { usePageStore } from "@/stores/page";

/** Tiêu đề trang (đường dẫn nhỏ · tiêu đề lớn · mô tả ngắn) — nằm trong Topbar dùng chung. */
export function PageHeader() {
  const meta = usePageStore((state) => state.meta);
  return (
    <div className="min-w-0">
      <p className="truncate text-[13px] text-muted">{meta.breadcrumb}</p>
      <h1 className="mt-0.5 truncate font-display text-[34px] font-extrabold leading-[1.15] text-navy short:text-[28px]">{meta.title}</h1>
      <p className="mt-1 truncate text-[15px] text-muted short:text-sm">{meta.subtitle}</p>
    </div>
  );
}
