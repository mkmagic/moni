/** The deployed release version, sourced from the git release tag at build
 * time (`.github/workflows/deploy.yml` passes `github.event.release.tag_name`
 * as `NEXT_PUBLIC_MONI_RELEASE_TAG`), with any leading "v" stripped. Empty in
 * dev and other non-release builds, where no tag exists. */
export const APP_VERSION = (process.env.NEXT_PUBLIC_MONI_RELEASE_TAG ?? "").replace(/^v/, "");
