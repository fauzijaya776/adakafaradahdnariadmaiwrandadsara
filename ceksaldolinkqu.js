const axios = require('axios');

// Fungsi untuk mengambil data
async function getMutationReport() {
  // Konfigurasi untuk permintaan Axios
  const config = {
    method: 'get',
    url: 'https://api.linkqu.id/linkqu-partner/akun/resume?username=LI789HRAI',
    headers: {
      'client-id': '5b71b934-6e0c-40e7-906d-77f6424148ec',
      'client-secret': 'lHjI8AbcRhTifij6J9bJ16HpG'
    }
  };

  try {
    // Mengirim permintaan menggunakan Axios
    const response = await axios(config);

    // Menampilkan data yang diterima
    console.log('Request Successful!');
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    // Menangani jika terjadi error
    console.error('Error fetching data:');
    if (error.response) {
      // Server merespons dengan status error (4xx atau 5xx)
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    } else if (error.request) {
      // Permintaan dibuat tapi tidak ada respons
      console.error('No response received:', error.request);
    } else {
      // Error lain
      console.error('Error:', error.message);
    }
  }
}

// Panggil fungsi untuk menjalankannya
getMutationReport();