/** 15. Đồng nhất giao diện giữa các trang: Sidebar và Topbar không đổi khi chuyển trang. */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { installMockApi } from "./mockApi";
import { renderApp } from "./renderApp";

const PAGES = [
  { link: "Trang chủ", title: "Xin chào, Test", path: "/" },
  { link: "Quét thuốc", title: "Quét thuốc", path: "/scan" },
  { link: "Thuốc trong tủ", title: "Thuốc trong tủ", path: "/cabinet" },
  { link: "Hạn dùng", title: "Hạn dùng", path: "/expiry" },
  { link: "Nhắc uống thuốc", title: "Nhắc uống thuốc", path: "/reminders" },
  { link: "Cảnh báo", title: "Cảnh báo", path: "/alerts" },
  { link: "Lịch sử", title: "Lịch sử", path: "/history" },
  { link: "Hồ sơ", title: "Hồ sơ", path: "/profile" },
  { link: "Cài đặt", title: "Cài đặt", path: "/settings" },
];

/** Dấu vân tay cấu trúc: thẻ + class của khung (không tính nội dung thay đổi theo trang). */
function signature(element: HTMLElement): string {
  const own = `${element.tagName}.${element.className}`;
  const children = Array.from(element.children).map((child) => `${child.tagName}.${(child as HTMLElement).className.replace(/bg-primary-soft|font-semibold|text-primary|font-medium|text-muted|hover:\S+/g, "").replace(/\s+/g, " ").trim()}`);
  return [own, ...children].join("|");
}

describe("AppShell dùng chung cho mọi trang", () => {
  beforeEach(() => {
    installMockApi();
  });

  it("giữ nguyên Sidebar và Topbar (cùng phần tử DOM, cùng cấu trúc) khi đi qua 9 trang", async () => {
    const user = userEvent.setup();
    renderApp("/");
    const sidebar = screen.getByTestId("sidebar");
    const topbar = screen.getByTestId("topbar");
    const sidebarSignature = signature(sidebar);
    const topbarSignature = signature(topbar);

    for (const page of PAGES) {
      await user.click(within(sidebar).getByRole("link", { name: new RegExp(`^${page.link}`) }));
      await waitFor(() => expect(within(topbar).getByRole("heading", { level: 1 })).toHaveTextContent(page.title));

      // Không bị dựng lại: vẫn đúng các phần tử cũ và chỉ có một bản.
      expect(screen.getByTestId("sidebar")).toBe(sidebar);
      expect(screen.getByTestId("topbar")).toBe(topbar);
      expect(screen.getAllByTestId("sidebar")).toHaveLength(1);
      expect(screen.getAllByTestId("topbar")).toHaveLength(1);
      expect(signature(sidebar)).toBe(sidebarSignature);
      expect(signature(topbar)).toBe(topbarSignature);

      // Đúng 9 mục điều hướng theo thứ tự thiết kế, mục hiện tại được đánh dấu.
      const links = within(sidebar).getAllByRole("link").map((link) => link.textContent?.replace(/\d+$/, "").trim());
      expect(links).toEqual(PAGES.map((p) => p.link));
      expect(within(sidebar).getByRole("link", { current: "page" })).toHaveTextContent(page.link);

      // Topbar luôn có ngày giờ + 3 nút nhanh.
      expect(within(topbar).getByLabelText("Ngày giờ hiện tại")).toBeInTheDocument();
      expect(within(topbar).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Cảnh báo", "Cài đặt", "Hồ sơ"]);
      expect(screen.getByTestId("page-content")).toBeInTheDocument();
    }
  });

  it.each(PAGES)("trang $path hiển thị đúng tiêu đề và đường dẫn nhỏ", async ({ path, title }) => {
    renderApp(path);
    const topbar = screen.getByTestId("topbar");
    await waitFor(() => expect(within(topbar).getByRole("heading", { level: 1 })).toHaveTextContent(title));
    expect(topbar.querySelector("p")).toHaveTextContent(/^Tủ thuốc thông minh/);
  });

  it("các nút nhanh trên Topbar dẫn tới đúng trang", async () => {
    const user = userEvent.setup();
    renderApp("/");
    const topbar = screen.getByTestId("topbar");
    await user.click(within(topbar).getByRole("button", { name: "Cài đặt" }));
    await waitFor(() => expect(within(topbar).getByRole("heading", { level: 1 })).toHaveTextContent("Cài đặt"));
    await user.click(within(topbar).getByRole("button", { name: "Cảnh báo" }));
    await waitFor(() => expect(within(topbar).getByRole("heading", { level: 1 })).toHaveTextContent("Cảnh báo"));
  });

  it("đường dẫn lạ quay về Trang chủ", async () => {
    renderApp("/khong-ton-tai");
    await waitFor(() => expect(within(screen.getByTestId("topbar")).getByRole("heading", { level: 1 })).toHaveTextContent("Xin chào"));
  });
});
