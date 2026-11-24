import { router } from "expo-router";
import { ServerScreen } from "@/screens/ServerScreen";

export default function ServerRoute() {
  return <ServerScreen onDone={() => (router.canGoBack() ? router.back() : router.replace("/login"))} />;
}
