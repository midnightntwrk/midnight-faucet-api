import crypto from "node:crypto";

// Key and IV generation
const algorithm = "chacha20-poly1305";
const encoding = "hex";

export const encryptData = (encryptionKey: Buffer, data: string): string => {
  const iv = crypto.randomBytes(12); // Generate a 12-byte nonce for ChaCha20-Poly1305
  const assocData = crypto.randomBytes(16);

  const cipher = crypto.createCipheriv(algorithm, encryptionKey, iv, { authTagLength: 16 });
  cipher.setAAD(assocData, {
    plaintextLength: Buffer.byteLength(data),
  });

  const encrypted = Buffer.concat([cipher.update(data, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return (
    iv.toString(encoding) +
    assocData.toString(encoding) +
    encrypted.toString(encoding) +
    tag.toString(encoding)
  );
};

export const splitEncryptedData = (encryptedData: string) => ({
  ivString: encryptedData.slice(0, 24),
  assocDataString: encryptedData.slice(24, 56),
  encryptedDataString: encryptedData.slice(56, -32),
  authTagString: encryptedData.slice(-32),
});

type encryptedDataType = {
  encryptedDataString: string;
  ivString: string;
  assocDataString: string;
  authTagString: string;
};

export const decryptData = (encryptionKey: Buffer, encryptedData: string): string => {
  const { encryptedDataString, ivString, assocDataString, authTagString }: encryptedDataType =
    splitEncryptedData(encryptedData);

  const iv = Buffer.from(ivString, encoding);
  const encryptedText = Buffer.from(encryptedDataString, encoding);
  const tag = Buffer.from(authTagString, encoding);

  const decipher = crypto.createDecipheriv(algorithm, encryptionKey, iv, {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(assocDataString, encoding), {
    plaintextLength: encryptedDataString.length,
  });
  decipher.setAuthTag(Buffer.from(tag));

  const decrypted = decipher.update(encryptedText);
  return Buffer.concat([decrypted, decipher.final()]).toString();
};
