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
  { label: "projects", href: "/projects" },
  { label: "blog", href: "/blog" },
] as const;

export const SOCIAL_LINKS = [
  {
    label: "GitHub",
    href: "https://github.com/uchkunrakhimow",
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
  subtitle: "specializing in scalable distributed systems",
  description:
    "I'm a backend engineer with 3+ years of experience building scalable, high-performance systems. My core stack includes Node.js, TypeScript, and frameworks like NestJS, Express, and Fastify, backed by PostgreSQL and MongoDB. I architect distributed services on GCP, implement robust CI/CD pipelines, and maintain comprehensive monitoring and logging. On the frontend, I work with React.js to deliver complete, end-to-end solutions.",
} as const;

import experienceData from "../content/experience.json";
export const EXPERIENCE = experienceData.jobs;

export const PROJECTS = [
  {
    name: "TedbookCRM",
    description:
      "Full-stack CRM system supporting web and mobile platforms with role-based access, real-time Socket.io updates, and Firebase push notifications for couriers.",
    tech: ["Express.js", "TypeScript", "MongoDB", "Socket.io", "Firebase"],
    metrics: "50+ daily orders, 10+ users, 600+ total transactions",
  },
  {
    name: "WiFi Captive Portal",
    description:
      "High-throughput authentication system with OTP-based SMS verification integrated with Unifi controller for seamless network access across multiple branches.",
    tech: ["Node.js", "TypeScript", "MySQL", "Sequelize", "Unifi API"],
    metrics: "1,000+ daily registrations, 14 branch locations",
  },
  {
    name: "Numeo.ai Chrome Extension",
    description:
      "Backend infrastructure for Chrome extension with real-time load filtering and AI integration for logistics workflows, built on GCP.",
    tech: ["TypeScript", "GCP", "MongoDB", "Microsoft Rush"],
    metrics: "1,000+ active users",
  },
  {
    name: "Assetsy v2 API",
    description:
      "Fastify-based microservice API redesign with improved endpoint structure, MongoDB transaction handling, and zero-downtime database migrations.",
    tech: ["Fastify", "TypeScript", "MongoDB"],
  },
  {
    name: "PillPlan Notifications",
    description:
      "Automated medication reminder system using GCP Cloud Tasks for scheduled push notifications with queue-based architecture and retry logic.",
    tech: ["NestJS", "GCP Cloud Tasks", "APNs", "GitHub Actions"],
  },
  {
    name: "VoIP Integration System",
    description:
      "Node.js middleware connecting Asterisk phone systems with custom call queue management, real-time monitoring, spy mode, and intelligent call routing.",
    tech: ["Node.js", "Asterisk", "WebSocket"],
    metrics: "Sub-second latency for live call data",
  },
] as const;
