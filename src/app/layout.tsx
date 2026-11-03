import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SiteHeader } from "@/components/SiteHeader";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CartWitness — proof of human permission for AI purchases",
  description: "Buyers approve exactly what an AI shopping agent may buy; every purchase is checked against that approval.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <SiteHeader />
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
        <footer className="border-t border-[var(--line)] py-6 text-center text-xs text-[var(--muted)]">
          CartWitness · PayPal AI Hackathon 2026 · Sandbox only — no real money moves. Records are tamper-evident, not a legal guarantee. · <a href="/setup" className="underline">Setup status</a>
        </footer>
      </body>
    </html>
  );
}
