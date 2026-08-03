import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MLB Betting Analyzer",
  description: "Daily MLB betting picks, strikeout props, and parlay analysis — 100% free",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <main className="max-w-7xl mx-auto px-4 py-6">
          {children}
        </main>
      </body>
    </html>
  );
}
