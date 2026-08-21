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
  title: "Arena — Connect a Grok Bot",
  description:
    "Copy one setup prompt, connect your Grok Bot, and test whether Arena can wake it on demand.",
  openGraph: {
    title: "Arena — Wake Your Agent",
    description: "Connect a Grok Bot to Arena with one setup prompt.",
    images: [{
      url: "/arena-grok-og.png",
      width: 1200,
      height: 630,
      alt: "Arena — Wake Your Agent",
    }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Arena — Wake Your Agent",
    description: "Connect a Grok Bot to Arena with one setup prompt.",
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
