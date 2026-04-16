export const SITE = {
  name: "Uchkun Rakhimov",
  title: "Uchkun Rakhimov",
  titleTemplate: "%s | uchkun.io",
  description:
    "Backend Engineer specializing in scalable distributed systems. 3+ years building with Node.js, TypeScript, NestJS, PostgreSQL, and cloud infrastructure.",
  url: "https://uchkun.io",
  ogImage: "/og-image.jpg",
  twitterHandle: "@uchkunrakhimov",
  locale: "en_US",
} as const;

export const NAV_LINKS = [
  { label: "blog", href: "/blog" },
] as const;

export const SOCIAL_LINKS = [
  {
    label: "GitHub",
    href: "https://github.com/uchkunr",
    icon: "github",
  },
  {
    label: "Twitter",
    href: "https://twitter.com/uchkunrakhimov",
    icon: "twitter",
  },
  {
    label: "LinkedIn",
    href: "https://www.linkedin.com/in/uchkunio",
    icon: "linkedin",
  },
  {
    label: "Email",
    href: "mailto:uchkunrakhimov@gmail.com",
    icon: "mail",
  },
] as const;

export const RESUME_URL =
  "https://docs.google.com/document/d/1urFr8PbkJc7hbxIc53rLXC0qdW0sCjIwkt84ONxhhFY/edit?usp=sharing";

export const BIO = {
  name: "Uchkun Rakhimov",
  title: "Backend Engineer",
  subtitle: "currently CTO at Carlink, based in Tashkent",
  description:
    "I build the quiet half of software — the part that doesn't break on Fridays and doesn't wake anyone at 3am. Mostly I think about how systems age: what makes a service survive its tenth migration, and what makes \"it works\" eventually become \"it's good.\" I write here about what I learn along the way.",
} as const;

import experienceData from "../content/experience.json";
export const EXPERIENCE = experienceData.jobs;

export const PROJECTS: readonly Project[] = [
  // ── Work projects ──────────────────────────────────────────
  {
    type: "work",
    featured: true,
    name: "TedbookCRM",
    description:
      "Architected and built a complete CRM system from scratch for a courier business. Multi-role access (operators, logistics managers, warehouse staff, couriers), real-time order tracking via Socket.io, Firebase push notifications to courier mobile apps, and an admin analytics dashboard with daily/weekly/monthly reporting.",
    tech: ["Express.js", "TypeScript", "MongoDB", "Socket.io", "Firebase"],
    metrics: "600+ total orders · 50+ orders/day · 10+ active users",
  },
  {
    type: "work",
    featured: true,
    name: "Carlink B2B Platform",
    description:
      "Designed the backend architecture for a B2B auto transport marketplace as CTO — multi-tenant data model, REST API, and integration layer with Central Dispatch, SuperDispatch, and QuickBooks. Set up CI/CD, code review process, and dev environment standards from day one.",
    tech: ["Node.js", "TypeScript", "PostgreSQL", "Docker", "GitHub Actions"],
  },
  {
    type: "work",
    name: "WiFi Captive Portal",
    description:
      "High-throughput guest Wi-Fi authentication system deployed across 14 branch locations. OTP-based SMS verification with automatic session provisioning via the UniFi Controller API. Built with zero manual configuration overhead after initial deployment.",
    tech: ["Node.js", "TypeScript", "MySQL", "Sequelize", "UniFi API"],
    metrics: "1,000+ daily sessions · 14 branch locations",
    github: "https://github.com/uchkunr/otpgate-unifi",
  },
  {
    type: "work",
    name: "PillPlan Notification Engine",
    description:
      "Queue-based medication reminder system using GCP Cloud Tasks for scheduled APNs delivery to iOS devices. Retry logic with backoff for failed deliveries, Nx monorepo refactor following clean code principles, and a GitHub Actions CI/CD pipeline for zero-downtime deploys. Project was closed by the company after handoff.",
    tech: ["NestJS", "GCP Cloud Tasks", "APNs", "Nx", "GitHub Actions"],
  },
  {
    type: "work",
    featured: true,
    name: "Numeo.ai Chrome Extension Backend",
    description:
      "Scalable GCP + MongoDB backend powering a logistics Chrome extension. Real-time load filtering engine, AI-assisted rate suggestions, and a TypeScript + React monorepo managed with Microsoft Rush. Includes structured GCP logging, on-call alerting, and error tracking for production stability.",
    tech: ["TypeScript", "GCP", "MongoDB", "Microsoft Rush", "React"],
    metrics: "1,000+ active users",
  },
  {
    type: "work",
    name: "VoIP Integration Middleware",
    description:
      "Node.js middleware bridging Asterisk PBX with a custom operator dashboard. Live call monitoring, spy/whisper mode, pause controls, and intelligent queue routing — all over a WebSocket event stream with sub-second latency. Open-sourced the Asterisk AMI client as a standalone package.",
    tech: ["Node.js", "TypeScript", "Asterisk AMI", "WebSocket"],
    metrics: "60+ concurrent agents · sub-second latency",
    github: "https://github.com/uchkunr/NodeJS-AsteriskManager",
  },
  {
    type: "work",
    name: "Assetsy v2 API",
    description:
      "Led API redesign for a Fastify-based asset management microservice at Startups DNA — restructured endpoint contracts, replaced ad-hoc queries with transactional MongoDB aggregation pipelines, added database indexing strategies, and executed zero-downtime schema migrations.",
    tech: ["Fastify", "TypeScript", "MongoDB"],
  },

  // ── Open source ────────────────────────────────────────────
  {
    type: "oss",
    featured: true,
    name: "UniFi Best Practices",
    description:
      "Comprehensive developer reference for the Ubiquiti UniFi Controller API — the documentation the official docs should have been. Covers authentication, device management, client operations, VLAN config, real-time WebSocket events, and DPI analytics with working Node.js examples.",
    tech: ["Node.js", "JavaScript", "UniFi API"],
    metrics: "17 stars · 1 fork",
    github: "https://github.com/uchkunr/unifi-best-practices",
  },
  {
    type: "oss",
    name: "HRCS API",
    description:
      "HR candidate screening REST API built with Bun + Elysia.js. Multi-tenant organization support, candidate lifecycle management, multilingual question banking, JWT auth, and PDF result exports. Structured for rapid deployment with Prisma + PostgreSQL.",
    tech: ["Bun", "Elysia.js", "TypeScript", "PostgreSQL", "Prisma"],
    github: "https://github.com/uchkunr/hrcs-api",
  },
  {
    type: "oss",
    name: "Auth Kit",
    description:
      "Modern authentication platform covering passkeys, OAuth providers, session management, and RBAC. Built as a reference implementation for production-grade auth in TypeScript backends.",
    tech: ["TypeScript", "Node.js", "PostgreSQL"],
    github: "https://github.com/uchkunr/auth-kit",
  },
  {
    type: "oss",
    name: "Vision Shop",
    description:
      "AI-powered product analysis tool combining Google Cloud Vision API with OpenAI GPT — takes a product image, extracts attributes, and generates structured metadata for e-commerce listings.",
    tech: ["TypeScript", "Google Vision API", "OpenAI"],
    github: "https://github.com/uchkunr/vision-shop",
  },
] as const;

type Project = {
  type: "work" | "oss";
  name: string;
  description: string;
  tech: readonly string[];
  featured?: boolean;
  metrics?: string;
  github?: string;
  live?: string;
};
