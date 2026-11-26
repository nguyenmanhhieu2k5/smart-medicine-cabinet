import { Redirect } from "expo-router";
import { useAuth } from "@/auth/AuthProvider";

/** Điểm vào: đã đăng nhập (hoặc khách quét thử trên trang web) → màn hình Quét, chưa → Đăng nhập. */
export default function Index() {
  const { status } = useAuth();
  return <Redirect href={status === "signedIn" || status === "guest" ? "/scan" : "/login"} />;
}
