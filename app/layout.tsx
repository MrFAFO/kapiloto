import type { Metadata } from "next";
import { Noto_Sans_Hebrew, Rubik } from "next/font/google";
import "./globals.css";

const hebrew = Noto_Sans_Hebrew({
  subsets: ["hebrew", "latin"],
  weight: ["400", "500", "700"],
  variable: "--font-hebrew",
  display: "swap",
});

const wordmark = Rubik({
  subsets: ["hebrew", "latin"],
  weight: ["800"],
  variable: "--font-wordmark",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Kapiloto",
  description: "Toto 16 group intelligence",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="he" dir="rtl" className={`${hebrew.variable} ${wordmark.variable}`}>
      <body>{children}</body>
    </html>
  );
}
