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
          {
            label: "Receiving & events",
            icon: "webhooks-logo",
            display: "group",
            items: [
              "/guides/receiving",
              "/reference/events",
              {
                label: "Email",
                icon: "envelope-simple",
                display: "group",
                items: [
                  "/reference/events/email/on-inbound",
                  "/reference/events/email/on-outbound",
                  "/reference/events/email/on-delivered",
                  "/reference/events/email/on-opened",
                  "/reference/events/email/on-clicked",
                  "/reference/events/email/on-bounced",
                  "/reference/events/email/on-complained",
                  "/reference/events/email/on-rejected",
                  "/reference/events/email/on-unknown",
                  "/reference/events/email/on-all",
                ],
              },
              {
                label: "Mailbox",
                icon: "tray",
                display: "group",
                items: [
                  "/reference/events/mailbox/on-connected",
                  "/reference/events/mailbox/on-auth-updated",
                  "/reference/events/mailbox/on-created",
                  "/reference/events/mailbox/on-deleted",
                ],
              },
              {
                label: "Domain",
                icon: "globe-simple",
                display: "group",
                items: [
                  "/reference/events/domain/on-created",
                  "/reference/events/domain/on-verified",
                  "/reference/events/domain/on-deleted",
                ],
              },
              {
                label: "Webhook",
                icon: "plugs-connected",
                display: "group",
                items: [
                  "/reference/events/webhook/on-created",
                  "/reference/events/webhook/on-updated",
                  "/reference/events/webhook/on-deleted",
                  "/reference/events/webhook/on-action-required",
                  "/reference/events/webhook/on-sync-required",
                  "/reference/events/webhook/on-all",
                ],
              },
            ],
          },
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
        items: ["/reference/client", "/reference/nextjs"],
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
  deployment: {
    site: "https://emailkit.paukraft.com",
  },
  seo: {
    og: {
      enabled: true,
      logo: "/emailkit-og-mark.svg",
      palette: {
        accent: "#2fa8ff",
        background: "#0a0a0a",
        foreground: "#fafafa",
        muted: "#a3a3a3",
        border: "#262626",
      },
    },
    sitemap: false,
    robots: true,
    structuredData: true,
  },
  lastModified: true,
});
