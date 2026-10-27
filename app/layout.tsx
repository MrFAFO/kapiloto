import type { Metadata } from "next";
import { Noto_Sans_Hebrew, Rubik } from "next/font/google";
import "./globals.css";

const hebrew = Noto_Sans_Hebrew({
  subsets: ["hebrew", "latin"],
  weight: ["400", "500", "700"],
  variable: "--font-hebrew",
  display: "swap",
});

const rubik = Rubik({
  subsets: ["hebrew", "latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-rubik",
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
    <html lang="he" dir="rtl" className={`${hebrew.variable} ${rubik.variable}`}>
      <body>{children}</body>
    </html>
  );
}
