import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import ThemeToggle from "./theme-toggle";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Realtime Voice Agent Demo",
  description: "A demo application showcasing OpenAI's Realtime API for voice conversation",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <header className="sticky top-0 z-30 backdrop-blur bg-[rgb(var(--surface))/0.8] shadow-sm">
          <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2 focus-ring">
              <div className="w-3 h-3 rounded-full" style={{background:"linear-gradient(135deg, rgb(var(--primary)), rgb(var(--accent)))"}} />
              <span className="font-semibold text-gray-800">Realtime Voice Agent</span>
            </Link>
            <ThemeToggle />
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
