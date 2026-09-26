# Storybook deployment

The design-system Storybook deploys as its own Vercel project,
`source-storybook`, whose Root Directory is this folder. Keeping its config
here (instead of the repo-root `vercel.json`) means it never inherits the
app's cron jobs. The build runs from the repo root and writes the static
site to `deploy/storybook/dist`.

Deploys run on every push to `main`. The `ignoreCommand` skips a build when
nothing Storybook depends on (`src`, `.storybook`, `public`, dependencies)
changed.

Run it locally with `npm run storybook`.
