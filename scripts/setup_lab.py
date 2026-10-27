"""Download the official Mojang server into an isolated, loopback-only lab."""
import hashlib
import argparse
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LAB = ROOT / 'runtime' / 'server'
VERSION = '1.21.1'


def get_json(url):
    with urllib.request.urlopen(url, timeout=45) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description='Prepare isolated vanilla server')
    parser.add_argument('--accept-eula', action='store_true', help='Accept https://aka.ms/MinecraftEULA for this lab')
    args = parser.parse_args()
    if not args.accept_eula:
        parser.error('Read https://aka.ms/MinecraftEULA and pass --accept-eula to prepare the lab')
    LAB.mkdir(parents=True, exist_ok=True)
    manifest = get_json('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')
    entry = next(v for v in manifest['versions'] if v['id'] == VERSION)
    metadata = get_json(entry['url'])
    server = metadata['downloads']['server']
    jar = LAB / 'server.jar'
    if not jar.exists() or hashlib.sha1(jar.read_bytes()).hexdigest() != server['sha1']:
        with urllib.request.urlopen(server['url'], timeout=120) as response:
            data = response.read()
        if hashlib.sha1(data).hexdigest() != server['sha1']:
            raise RuntimeError('Official server checksum mismatch')
        jar.write_bytes(data)
    # Dedicated experiment environment only. Never reuse a player's save here.
    (LAB / 'eula.txt').write_text('eula=true\n')
    props = {
        'server-ip': '127.0.0.1', 'server-port': '25575', 'online-mode': 'false',
        'enforce-secure-profile': 'false', 'enable-rcon': 'false', 'enable-query': 'false',
        'level-name': 'basic-lab', 'level-type': 'minecraft:flat',
        'generator-settings': json.dumps({'biome':'minecraft:plains','layers':[
            {'block':'minecraft:bedrock','height':1},
            {'block':'minecraft:dirt','height':2},
            {'block':'minecraft:grass_block','height':1}]}),
        'generate-structures': 'false', 'spawn-protection': '0',
        'gamemode': 'survival', 'difficulty': 'peaceful',
        'view-distance': '5', 'simulation-distance': '4', 'max-players': '6',
        'motd': 'Basic Agent isolated vanilla lab', 'level-seed': '789',
    }
    # Only write properties before the initial launch. Preserve intentional edits later.
    if not (LAB / 'server.properties').exists():
        (LAB / 'server.properties').write_text(''.join(f'{k}={v}\n' for k,v in props.items()))
    (LAB / 'download.json').write_text(json.dumps({
        'minecraft_version':VERSION,'metadata_url':entry['url'],
        'server_url':server['url'],'sha1':server['sha1'],'size':server['size'],
        'verified': True}, indent=2))
    print(f'Official Minecraft {VERSION} server verified: {jar}')
    print('Lab accepts the Minecraft EULA (https://aka.ms/MinecraftEULA).')
    print('Offline authentication is confined to 127.0.0.1; use a trusted local test world.')


if __name__ == '__main__':
    main()
