/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  transpilePackages: ["energy-flow-chart"],
  serverExternalPackages: ["pg", "exceljs"],
  poweredByHeader: false,
};

export default nextConfig;
