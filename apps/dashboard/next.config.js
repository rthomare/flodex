/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@fldx/protocol", "@fldx/client-lib"],
  reactStrictMode: true,
};

module.exports = nextConfig;
