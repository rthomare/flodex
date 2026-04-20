/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@flodex/protocol", "@flodex/client-lib"],
  reactStrictMode: true,
};

module.exports = nextConfig;
