import { describe, expect, it } from 'vitest';
import { classifyDataLocation, dataLocationWarning } from './data-location.js';

const ASK_IT =
  'Ask your IT team to keep this folder on this computer. The README\'s "For hospital IT" section explains how.';
const LOCAL = 'C:\\Users\\ana\\AppData\\Local';

describe('where the schedule database lives', () => {
  it('says nothing for an ordinary Windows profile on the C: drive', () => {
    const dataDir = 'C:\\Users\\ana\\AppData\\Roaming\\ShiftNurse';
    const location = classifyDataLocation({ platform: 'win32', dataDir, localAppData: LOCAL });
    expect(location).toBe('local');
    expect(dataLocationWarning(dataDir, location)).toBeNull();
  });

  it('warns when the hospital redirects AppData to a file server', () => {
    const dataDir = '\\\\fs01\\profiles$\\ana\\AppData\\Roaming\\ShiftNurse';
    const location = classifyDataLocation({ platform: 'win32', dataDir, localAppData: LOCAL });
    expect(location).toBe('network');
    expect(dataLocationWarning(dataDir, location)).toContain(ASK_IT);
    expect(dataLocationWarning(dataDir, location)).toMatch(
      /^Your ShiftNurse data is kept in a network folder \(\\\\fs01\\profiles\$\\ana\\AppData\\Roaming\\ShiftNurse\)\./,
    );
  });

  it('warns when AppData is redirected to a mapped H: drive', () => {
    const dataDir = 'H:\\AppData\\Roaming\\ShiftNurse';
    const location = classifyDataLocation({ platform: 'win32', dataDir, localAppData: LOCAL });
    expect(location).toBe('other-drive');
    expect(dataLocationWarning(dataDir, location)).toContain(ASK_IT);
    expect(dataLocationWarning(dataDir, location)).toMatch(
      /^Your ShiftNurse data is kept on another drive \(H:\\AppData\\Roaming\\ShiftNurse\)/,
    );
  });

  it('says nothing when Windows itself lives on D:', () => {
    expect(
      classifyDataLocation({
        platform: 'win32',
        dataDir: 'D:\\Users\\ana\\AppData\\Roaming\\ShiftNurse',
        localAppData: 'd:\\Users\\ana\\AppData\\Local',
      }),
    ).toBe('local');
  });

  it('says nothing when it cannot tell where local app data is', () => {
    expect(
      classifyDataLocation({
        platform: 'win32',
        dataDir: 'C:\\Users\\ana\\AppData\\Roaming\\ShiftNurse',
      }),
    ).toBe('local');
  });

  it('warns for a Mac network home folder', () => {
    expect(
      classifyDataLocation({
        platform: 'darwin',
        dataDir: '/Network/Servers/fs01/Users/ana/Library/Application Support/ShiftNurse',
      }),
    ).toBe('network');
  });

  it('warns when a Mac home folder sits on another volume', () => {
    expect(
      classifyDataLocation({
        platform: 'darwin',
        dataDir: '/Volumes/Home/Library/Application Support/ShiftNurse',
      }),
    ).toBe('other-drive');
  });

  it('says nothing for an ordinary Mac home folder', () => {
    expect(
      classifyDataLocation({
        platform: 'darwin',
        dataDir: '/Users/ana/Library/Application Support/ShiftNurse',
      }),
    ).toBe('local');
  });

  it('treats a forward-slash UNC path as a network folder too', () => {
    expect(
      classifyDataLocation({
        platform: 'win32',
        dataDir: '//fs01/profiles/ana/AppData/Roaming/ShiftNurse',
      }),
    ).toBe('network');
  });
});
