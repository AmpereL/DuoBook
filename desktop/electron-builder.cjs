const privateBuild = process.env.DUOBOOK_INCLUDE_PRIVATE_KEY === '1';
const mode = privateBuild ? 'private' : 'public';
module.exports = {
  appId: 'com.duobook.reader', productName: '逻辑阅读', electronDist: 'node_modules/electron/dist',
  directories: { output: `release/${mode}` },
  files: ['desktop/main.cjs', 'desktop/preload.cjs', 'desktop/compact-reader.cjs', 'desktop/compact-shortcut.cjs', 'desktop/reading-progress.cjs', 'package.json'],
  extraResources: [
    { from: `build/desktop/${mode}/backend`, to: 'backend' },
    { from: 'apps/web/dist', to: 'web', filter: ['**/*', '!**/*.map'] },
    ...(privateBuild ? [
      { from: 'build/desktop/private/private-defaults.json', to: 'private-defaults.json' },
      { from: 'build/desktop/private/private-speech-defaults.json', to: 'private-speech-defaults.json' },
    ] : []),
  ],
  asar: true,
  mac: {
    icon: 'build/逻辑阅读.icns', entitlements: 'desktop/entitlements.mac.plist', entitlementsInherit: 'desktop/entitlements.mac.plist',
    category: 'public.app-category.books', target: [{ target: 'dmg', arch: 'arm64' }, { target: 'zip', arch: 'arm64' }],
    hardenedRuntime: true, notarize: false, identity: '-',
    artifactName: privateBuild ? 'LogicReading-${version}-macOS-${arch}-private.${ext}' : 'LogicReading-${version}-macOS-${arch}.${ext}',
  },
  dmg: { title: '逻辑阅读', contents: [{ x: 150, y: 180 }, { x: 450, y: 180, type: 'link', path: '/Applications' }] },
};
