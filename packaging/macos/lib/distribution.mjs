/** Apple flat-package metadata. Kept pure so the installer contract is testable. */

export const PRODUCT = "Mona";
export const APP_BUNDLE_ID = "com.mona.workbench";
export const SERVICE_BUNDLE_ID = "com.mona.workbench.service";
export const PACKAGE_ID = "com.mona.workbench.pkg";
export const MINIMUM_MACOS = "14.0";
export const APP_PATH = "Applications/Mona.app";
export const SERVICE_PATH = "Library/Services/Mona.service";
export const RECEIPT_DIR = "Library/Application Support/Mona";
export const RECEIPT_PATH = `${RECEIPT_DIR}/install-receipt.json`;
export const OWNED_PATHS_PATH = `${RECEIPT_DIR}/owned-paths.json`;
/** The bounded, ownership-verified removal utility (P23). */
export const UNINSTALL_PATH = `${RECEIPT_DIR}/uninstall-mona.sh`;
export const UNINSTALL_SCRIPT = "uninstall-mona.sh";

export function packageFileName({ version, channel }) {
  const suffix = channel === "local" ? "-local" : "";
  return `Mona-${version}-macOS-arm64${suffix}.pkg`;
}

export function installerTitle(channel) {
  return channel === "local" ? "Mona — Local development build" : "Mona";
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * `hostArchitectures` and `allowed-os-versions` are enforced by Installer
 * before any script runs, so an Intel Mac or an older macOS gets a clear
 * refusal instead of a half-installed payload.
 */
export function renderDistribution({
  version,
  channel,
  componentFile,
  backgroundFile = "background.png",
  readmeFile = "readme.html",
}) {
  const title = installerTitle(channel);
  return `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>${escapeXml(title)}</title>
  <organization>${APP_BUNDLE_ID}</organization>
  <domains enable_localSystem="true" enable_currentUserHome="false" enable_anywhere="false"/>
  <options customize="never" require-scripts="true" rootVolumeOnly="true" hostArchitectures="arm64"/>
  <allowed-os-versions>
    <os-version min="${MINIMUM_MACOS}"/>
  </allowed-os-versions>
  <background file="${escapeXml(backgroundFile)}" alignment="bottomleft" scaling="none"/>
  <readme file="${escapeXml(readmeFile)}"/>
  <pkg-ref id="${PACKAGE_ID}"/>
  <choices-outline>
    <line choice="default"/>
  </choices-outline>
  <choice id="default" title="${escapeXml(title)}" description="Installs Mona and its Finder Service.">
    <pkg-ref id="${PACKAGE_ID}"/>
  </choice>
  <pkg-ref id="${PACKAGE_ID}" version="${escapeXml(version)}" onConclusion="none">${escapeXml(componentFile)}</pkg-ref>
</installer-gui-script>
`;
}

export function renderComponentPlist({ appPath = APP_PATH, servicePath = SERVICE_PATH } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
  <dict>
    <key>BundleHasStrictIdentifier</key><true/>
    <key>BundleIsRelocatable</key><false/>
    <key>BundleIsVersionChecked</key><true/>
    <key>BundleOverwriteAction</key><string>upgrade</string>
    <key>RootRelativeBundlePath</key><string>${appPath}</string>
  </dict>
  <dict>
    <key>BundleHasStrictIdentifier</key><true/>
    <key>BundleIsRelocatable</key><false/>
    <key>BundleIsVersionChecked</key><true/>
    <key>BundleOverwriteAction</key><string>upgrade</string>
    <key>RootRelativeBundlePath</key><string>${servicePath}</string>
  </dict>
</array>
</plist>
`;
}

export function renderOwnedPaths({ version, channel, packageFile, components }) {
  return (
    JSON.stringify(
      {
        schema_version: 1,
        product: PRODUCT,
        version,
        channel,
        package: packageFile,
        owned: [
          { path: `/${APP_PATH}`, kind: "app-bundle" },
          { path: `/${SERVICE_PATH}`, kind: "service-bundle" },
          { path: `/${RECEIPT_PATH}`, kind: "install-receipt" },
          { path: `/${OWNED_PATHS_PATH}`, kind: "ownership-manifest" },
          { path: `/${UNINSTALL_PATH}`, kind: "uninstall-utility" },
        ],
        components: components.map((component) => ({
          path: component.path,
          sha256: component.sha256,
        })),
        preserves: [
          "~/Library/Application Support/Mona (per-user state, projects, sessions)",
          "~/.codewhale and any external Codewhale installation",
          "user project folders",
        ],
      },
      null,
      2,
    ) + "\n"
  );
}
