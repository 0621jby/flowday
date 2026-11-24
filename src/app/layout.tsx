import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "FlowDay · 把今天，过得从容一点",
  description: "个人执行教练。为重要的事留出时间，从一个小小的行动开始。",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
