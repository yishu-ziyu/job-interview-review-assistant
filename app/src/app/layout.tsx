import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "求职面试复盘助手 MVP",
  description: "面试后 10 分钟内完成结构化复盘与下轮改进建议",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
