"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = decryptAESSecretStorageItem;
var _base = require("../base64.js");
var _deriveKeys = require("./internal/deriveKeys.js");
/*
 * Copyright 2024 The Matrix.org Foundation C.I.C.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Decrypt an AES-encrypted Secret Storage item.
 *
 * @param data - the encrypted data, returned by {@link utils/encryptAESSecretStorageItem.default | encryptAESSecretStorageItem}.
 * @param key - the encryption key to use as an input to the HKDF function which is used to derive the AES key. Must
 *    be the same as provided to {@link utils/encryptAESSecretStorageItem.default | encryptAESSecretStorageItem}.
 * @param name - the name of the secret. Also used as an input to the HKDF operation which is used to derive the AES
 *    key, so again must be the same as provided to {@link utils/encryptAESSecretStorageItem.default | encryptAESSecretStorageItem}.
 */
async function decryptAESSecretStorageItem(data, key, name) {
  const [aesKey, hmacKey] = await (0, _deriveKeys.deriveKeys)(key, name);
  const ciphertext = (0, _base.decodeBase64)(data.ciphertext);
  if (!(await globalThis.crypto.subtle.verify({
    name: "HMAC"
  }, hmacKey, (0, _base.decodeBase64)(data.mac), ciphertext))) {
    throw new Error(`Error decrypting secret ${name}: bad MAC`);
  }
  const plaintext = await globalThis.crypto.subtle.decrypt({
    name: "AES-CTR",
    counter: (0, _base.decodeBase64)(data.iv),
    length: 64
  }, aesKey, ciphertext);
  return new TextDecoder().decode(new Uint8Array(plaintext));
}