import { config, collection, singleton, fields } from "@keystatic/core";

export default config({
  storage:
    process.env.NODE_ENV === "production"
      ? {
          kind: "github",
          repo: {
            owner: "uchkunrakhimow",
            name: "uchkunio",
          },
        }
      : { kind: "local" },

  collections: {
    blog: collection({
      label: "Blog",
      slugField: "title",
      path: "src/content/blog/*",
      format: { contentField: "content" },
      schema: {
        title: fields.slug({ name: { label: "Title" } }),
        date: fields.text({ label: "Date" }),
        excerpt: fields.text({ label: "Excerpt", multiline: true }),
        tags: fields.array(fields.text({ label: "Tag" }), {
          label: "Tags",
          itemLabel: (props) => props.value || "Tag",
        }),
        content: fields.markdoc({ label: "Content", extension: "md" }),
      },
    }),
  },

  singletons: {
    experience: singleton({
      label: "Experience",
      path: "src/content/experience",
      format: { data: "json" },
      schema: {
        jobs: fields.array(
          fields.object({
            company: fields.text({ label: "Company" }),
            website: fields.text({ label: "Website", validation: { isRequired: false } }),
            location: fields.text({ label: "Location" }),
            roles: fields.array(
              fields.object({
                title: fields.text({ label: "Title" }),
                project: fields.text({ label: "Project (optional)", validation: { isRequired: false } }),
                period: fields.text({ label: "Period" }),
                highlights: fields.array(fields.text({ label: "Highlight", multiline: true }), {
                  label: "Highlights",
                  itemLabel: (props) => props.value?.slice(0, 50) || "Highlight",
                }),
              }),
              {
                label: "Roles",
                itemLabel: (props) => props.fields?.title?.value || "Role",
              }
            ),
          }),
          {
            label: "Jobs",
            itemLabel: (props) => props.fields?.company?.value || "Company",
          }
        ),
      },
    }),
  },
});
