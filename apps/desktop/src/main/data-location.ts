/**
 * Is the data folder somewhere SQLite should not live?
 *
 * SQLite's WAL mode is unsafe on network file systems, and Windows keeps `userData` in the
 * Roaming profile, which many hospital domains redirect to a file server. Moving the file would
 * strand existing installs (D24), so the app keeps `userData` and says in words when it looks
 * redirected. A plain Roaming profile on `C:` is the default everywhere and must stay silent: a
 * warning shown to everyone gets ignored.
 *
 * Plain string checks, not `node:path`: tests run on macOS and Linux, where `path.win32` would be
 * needed, and a string check is host-independent.
 */

export type DataLocation = 'local' | 'network' | 'other-drive';

export function classifyDataLocation(input: {
  /** `process.platform`. */
  platform: string;
  /** `app.getPath('userData')`. */
  dataDir: string;
  /** `process.env.LOCALAPPDATA` (Windows). */
  localAppData?: string;
}): DataLocation {
  const { platform, dataDir, localAppData } = input;
  if (platform === 'win32') {
    // A UNC path is folder redirection to a share.
    if (dataDir.startsWith('\\\\') || dataDir.startsWith('//')) return 'network';
    // Roaming moved to a mapped drive while Local stayed on this PC.
    const dataDrive = dataDir.charAt(1) === ':' ? dataDir.charAt(0).toLowerCase() : undefined;
    const localDrive =
      localAppData && localAppData.charAt(1) === ':'
        ? localAppData.charAt(0).toLowerCase()
        : undefined;
    if (dataDrive && localDrive && dataDrive !== localDrive) return 'other-drive';
    return 'local';
  }
  if (platform === 'darwin') {
    if (dataDir.startsWith('/Network/')) return 'network';
    if (dataDir.startsWith('/Volumes/')) return 'other-drive';
  }
  return 'local';
}

const ASK_IT =
  'Ask your IT team to keep this folder on this computer. The README\'s "For hospital IT" section explains how.';

export function dataLocationWarning(dataDir: string, location: DataLocation): string | null {
  if (location === 'network')
    return `Your ShiftNurse data is kept in a network folder (${dataDir}). A schedule database in a network folder can be damaged if the connection drops, or if you are signed in on two computers at once, and its backups are in the same place. ${ASK_IT}`;
  if (location === 'other-drive')
    return `Your ShiftNurse data is kept on another drive (${dataDir}), not with the rest of this computer's app data. If that is a network drive, the schedule database can be damaged when the connection drops. ${ASK_IT}`;
  return null;
}
