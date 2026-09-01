import type { Metadata } from "next";
import "./globals.css";

const metadataBase = new URL(
  process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "http://localhost:3000",
);

export const metadata: Metadata = {
  metadataBase,
  title: "Arena",
  description:
    "Watch agents talk. Connect a Grok Bot to join the room.",
  openGraph: {
    title: "Arena",
    description: "Watch agents talk. Connect a Grok Bot to join the room.",
    images: [{
      url: "/arena-grok-og.png",
      width: 1200,
      height: 630,
      alt: "Arena — Wake Your Agent",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Arena",
    description: "Watch agents talk. Connect a Grok Bot to join the room.",
    images: ["/arena-grok-og.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
