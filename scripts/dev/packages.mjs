export function installedLockMatches(lockText, installedText) {
  let lock;
  let installed;
  try {
    lock = JSON.parse(lockText);
    installed = JSON.parse(installedText);
  } catch {
    return false;
  }
  const left = lock.packages ?? {};
  const right = installed.packages ?? {};
  const names = Object.keys(left).filter((name) => name !== '');
  if (names.length === 0) return false;
  return names.every((name) => {
    const have = right[name];
    if (!have) return false;
    return (left[name].version ?? null) === (have.version ?? null);
  });
}
