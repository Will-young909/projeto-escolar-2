
const { initializeApp, cert } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');

// ATENÇÃO: Substitua com as suas credenciais do Firebase
const serviceAccount = require('../../config/firebase-service-account.json');

initializeApp({
  credential: cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});

const bucket = getStorage().bucket();

/**
 * Faz o upload de um arquivo para o Firebase Storage.
 *
 * @param {Buffer} buffer O buffer do arquivo a ser enviado.
 * @param {string} destination O caminho de destino no bucket (ex: 'fotos-perfil/usuario-123.jpg').
 * @returns {Promise<string>} A URL pública do arquivo.
 */
async function uploadFile(buffer, destination) {
  const file = bucket.file(destination);

  await file.save(buffer, {
    metadata: {
      contentType: 'image/jpeg', // Ajuste o tipo de conteúdo conforme necessário
    },
    public: true, // Torna o arquivo público
  });

  return file.publicUrl();
}

module.exports = {
  uploadFile,
};
