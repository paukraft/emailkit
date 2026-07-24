import { defineConfig } from "blume";

export default defineConfig({
  title: "emailkit",
  description:
    "One TypeScript API for sending, receiving, and managing email across API and mailbox providers.",
  logo: {
    image: "/emailkit-logo.png",
    text: "emailkit",
  },
  github: {
    owner: "paukraft",
    repo: "emailkit",
    branch: "main",
    dir: "apps/docs",
  },
  content: {
    root: "docs",
  },
  navigation: {
    sidebar: [
      "/introduction",
      "/quickstart",
      "/concepts",
      {
        label: "Use cases",
        items: ["/use-cases/app-email", "/use-cases/bring-your-own-email"],
      },
      {
        label: "Build with emailkit",
        items: [
          "/guides/sending",
          "/guides/receiving",
          "/guides/mailboxes",
          "/guides/domains",
          "/guides/multiple-providers",
          "/guides/sync",
        ],
      },
      {
        label: "Providers",
        items: [
          "/providers",
          "/providers/resend",
          "/providers/mailgun",
          "/providers/aiinbx",
          "/providers/gmail",
          "/providers/outlook",
        ],
      },
      {
        label: "Reference",
        items: ["/reference/client", "/reference/events", "/reference/nextjs"],
      },
    ],
  },
  theme: {
    accent: { light: "#0284c7", dark: "#2fa8ff" },
    action: "#0284c7",
    background: { light: "#ffffff", dark: "#0a0a0a" },
    radius: "md",
    mode: "dark",
    fonts: {
      display: "space-grotesk",
      body: "source-sans-3",
      mono: "ibm-plex-mono",
    },
  },
  search: {
    provider: "orama",
  },
  markdown: {
    imageZoom: true,
    code: {
      icons: true,
      wrap: false,
    },
  },
  ai: {
    llmsTxt: true,
  },
  seo: {
    og: { enabled: false },
    sitemap: false,
    robots: true,
    structuredData: true,
  },
  lastModified: true,
});
