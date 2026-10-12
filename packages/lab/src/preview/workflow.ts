/** @internal The controller/config come from the base; only the image build uses PR code. */
export function previewWorkflow(): string {
	return `name: Lab preview
on:
  pull_request:
    types: [opened, reopened, synchronize, edited, closed]
permissions:
  contents: read
  pull-requests: read
  packages: write
  deployments: write
concurrency:
  group: lab-\${{ github.repository_id }}-\${{ github.event.number }}
  cancel-in-progress: false
jobs:
  preview:
    if: >-
      github.event.pull_request.head.repo.full_name == github.repository &&
      (github.event.action != 'edited' || github.event.changes.body != null)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          ref: \${{ github.event.pull_request.base.sha }}
      - uses: actions/setup-node@v7
        with:
          node-version: '24'
      - name: Install and build controller
        run: |
          corepack enable
          node -e 'const c = require("./lab.preview.json"); require("node:child_process").execSync(c.install, {stdio:"inherit"}); require("node:child_process").execSync(c.build, {stdio:"inherit"}); require("node:fs").appendFileSync(process.env.GITHUB_ENV, "LAB_CLI=" + (c.cwd || ".") + "/node_modules/.bin/slipher-lab\\n")'
      - name: Remove closed preview
        if: github.event.action == 'closed'
        run: '"$LAB_CLI" preview destroy'
        env:
          GITHUB_TOKEN: \${{ github.token }}
          SLIPHER_LAB_DOKPLOY_KEY: \${{ secrets.LAB_DOKPLOY_KEY }}
          SLIPHER_LAB_SSH_KEY: \${{ secrets.LAB_SSH_KEY }}
          SLIPHER_LAB_SSH_KNOWN_HOSTS: \${{ secrets.LAB_SSH_KNOWN_HOSTS }}
      - uses: actions/checkout@v7
        if: github.event.action != 'closed'
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          path: .slipher-source
      - name: Capture PR and prepare image
        id: prepare
        if: github.event.action != 'closed'
        run: '"$LAB_CLI" preview prepare --source .slipher-source'
        env:
          GITHUB_TOKEN: \${{ github.token }}
      - uses: actions/upload-artifact@v7
        if: github.event.action != 'closed'
        with:
          name: lab-pr-\${{ github.event.number }}-recipe
          path: .slipher-source/.slipher-preview/pr.json
          include-hidden-files: true
      - name: Build and publish image
        id: image
        if: github.event.action != 'closed'
        env:
          IMAGE: \${{ steps.prepare.outputs.image }}
          GH_TOKEN: \${{ github.token }}
          REGISTRY_USER: \${{ github.actor }}
        run: |
          printf '%s' "$GH_TOKEN" | docker login ghcr.io --username "$REGISTRY_USER" --password-stdin
          docker build --file .slipher-source/.slipher-preview/Dockerfile --tag "$IMAGE" .slipher-source
          docker push "$IMAGE"
          printf 'digest=%s\\n' "$(docker inspect --format '{{index .RepoDigests 0}}' "$IMAGE")" >> "$GITHUB_OUTPUT"
      - name: Deploy and verify preview
        if: github.event.action != 'closed'
        run: '"$LAB_CLI" preview deploy --source .slipher-source --image "$IMAGE"'
        env:
          IMAGE: \${{ steps.image.outputs.digest }}
          GITHUB_TOKEN: \${{ github.token }}
          SLIPHER_LAB_DOKPLOY_KEY: \${{ secrets.LAB_DOKPLOY_KEY }}
          SLIPHER_LAB_SSH_KEY: \${{ secrets.LAB_SSH_KEY }}
          SLIPHER_LAB_SSH_KNOWN_HOSTS: \${{ secrets.LAB_SSH_KNOWN_HOSTS }}
          SLIPHER_LAB_REGISTRY_USERNAME: \${{ vars.LAB_REGISTRY_USERNAME }}
          SLIPHER_LAB_REGISTRY_TOKEN: \${{ secrets.LAB_REGISTRY_TOKEN }}
          SLIPHER_LAB_PASSWORD: \${{ secrets.LAB_PREVIEW_PASSWORD }}
          SLIPHER_LAB_ENV: \${{ secrets.LAB_PREVIEW_ENV }}
`;
}
