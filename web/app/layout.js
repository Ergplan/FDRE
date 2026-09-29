import "@/src/styles.css";
import "@/src/app.css";

export const metadata = {
  title: "FDRE Optimizer",
  description: "Hybrid RE sizing, dispatch and project finance",
};

export const viewport = { colorScheme: "dark", themeColor: "#0a0a0a" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
