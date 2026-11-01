"""Install the pinned public Vosk model under this project; never invoked by HTTP."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT=Path(__file__).resolve().parents[1]
MODEL='vosk-model-small-cn-0.22'
URL='https://alphacephei.com/vosk/models/'+MODEL+'.zip'
SHA256='3af8b0e7e0f835ae9d414ce5df580237a3cfb08d586c9fbbb0f7ff29ad5b14ba'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive',type=Path,help='Already downloaded official model zip')
    args=parser.parse_args()
    directory=ROOT/'.runtime/models';directory.mkdir(parents=True,exist_ok=True)
    archive=args.archive or directory/(MODEL+'.download.zip')
    if not args.archive:
        curl=shutil.which('curl.exe') or shutil.which('curl')
        if not curl: raise SystemExit('Download '+URL+' and rerun with --archive <file>.')
        subprocess.run([curl,'--fail','--location','--retry','2','--connect-timeout','20',
                        '--max-time','1800','--continue-at','-','--output',str(archive),URL],check=True)
    digest=hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest!=SHA256: raise SystemExit('Model SHA256 mismatch; no files installed. Download a fresh official archive.')
    with zipfile.ZipFile(archive) as z:
        for member in z.infolist():
            target=(directory/member.filename).resolve()
            if not target.is_relative_to((directory/MODEL).resolve()):
                raise SystemExit('Unexpected archive path; no files installed.')
        if z.testzip(): raise SystemExit('Corrupt zip; no files installed.')
        z.extractall(directory)
    (directory/'vosk-cn-source.json').write_text(json.dumps({'source':URL,'model':MODEL,
        'sha256':digest,'license':'Apache-2.0','license_reference':'https://alphacephei.com/vosk/models'},indent=2),encoding='utf-8')
    print('MODEL_READY '+str(directory/MODEL))

if __name__=='__main__':main()
