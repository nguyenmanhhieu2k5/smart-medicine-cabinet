import { Redirect } from "expo-router";
import { useAuth } from "@/auth/AuthProvider";

/** Điểm vào: đã đăng nhập → màn hình Quét, chưa → Đăng nhập. */
export default function Index() {
  const { status } = useAuth();
  return <Redirect href={status === "signedIn" ? "/scan" : "/login"} />;
}
