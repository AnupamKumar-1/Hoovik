import subprocess
import shlex

def convert_to_wav(src_path, dst_path):
    cmd = f'ffmpeg -y -i {shlex.quote(src_path)} -ac 1 -ar 16000 -vn {shlex.quote(dst_path)}'
    subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)