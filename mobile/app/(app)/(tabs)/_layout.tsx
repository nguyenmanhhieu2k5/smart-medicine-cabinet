import { Tabs } from "expo-router/js-tabs";
import { TabBar } from "@/components/TabBar";

/** Thanh điều hướng dưới: QUÉT — LỊCH SỬ — HỒ SƠ. */
export default function TabsLayout() {
  return (
    <Tabs tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false }} backBehavior="history">
      <Tabs.Screen name="scan" />
      <Tabs.Screen name="history" />
      <Tabs.Screen name="profile" />
    </Tabs>
  );
}
