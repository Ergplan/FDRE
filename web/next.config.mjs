/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["energy-flow-chart"],
  serverExternalPackages: ["pg", "exceljs"],
  poweredByHeader: false,
  // public product page and PDF (static files in public/product)
  async rewrites() {
    return [{ source: "/product", destination: "/product/index.html" }];
  },
};

export default nextConfig;
