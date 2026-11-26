import base64
import binascii
import os
from tempfile import NamedTemporaryFile

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def seal(key, value, associated):
    nonce = os.urandom(12)
    return nonce + AESGCM(key).encrypt(nonce, value, associated.encode())


def open_seal(key, value, associated):
    return AESGCM(key).decrypt(value[:12], value[12:], associated.encode())


class KeyVault:
    def __init__(self, directory):
        supplied = os.environ.get("FULLGRID_MASTER_KEY")
        if supplied is not None:
            self.master = self.decode(supplied)
            return
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "master.key"
        if not path.exists():
            with NamedTemporaryFile(dir=directory, prefix=".master-") as temp:
                temp.write(base64.b64encode(AESGCM.generate_key(bit_length=256)))
                temp.flush()
                os.fsync(temp.fileno())
                try:
                    os.link(temp.name, path)
                except FileExistsError:
                    pass
        self.master = self.decode(path.read_bytes().strip())

    @staticmethod
    def decode(value):
        try:
            key = base64.b64decode(value, validate=True)
        except binascii.Error:
            raise ValueError("FULLGRID_MASTER_KEY 必须是 Base64 编码的 32 字节密钥") from None
        if len(key) != 32:
            raise ValueError("FULLGRID_MASTER_KEY 必须是 Base64 编码的 32 字节密钥")
        return key

    def user_key(self, conn, user_id, *, create=False):
        row = conn.execute("SELECT ciphertext FROM model_user_keys WHERE user_id=?", (user_id,)).fetchone()
        if row is not None:
            return open_seal(self.master, row["ciphertext"], user_id)
        if create:
            key = AESGCM.generate_key(bit_length=256)
            conn.execute("INSERT INTO model_user_keys(user_id,ciphertext) VALUES (?,?)",
                         (user_id, seal(self.master, key, user_id)))
            return key
        raise KeyError(user_id)

    def encrypt(self, conn, user_id, connection_id, value):
        return seal(self.user_key(conn, user_id, create=True), value.encode(), connection_id)

    def decrypt(self, conn, row):
        return open_seal(self.user_key(conn, row["user_id"]), row["key_ciphertext"], row["id"]).decode()
