import {v2 as cloudinary} from "cloudinary";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export async function uploadToCloudinary(filePath, folder = "Doctors") {
  try {
    const result = await cloudinary.uploader.upload(filePath, {folder, resource_type: "imaege"});

    fs.unlinkSync(filePath); // Delete the local file after uploading; 

    return result;

  } catch (error) {
    console.error('Error uploading to Cloudinary:', error);
    throw error;
  }
}

export async function deleteFromCloudinary(publicId) {
  try {
    if (!publicId) {
      return;
    }
    const result = await cloudinary.uploader.destroy(publicId); 
  } catch (error) {
    console.error('Error deleting from Cloudinary:', error);
    throw error;
  }
}


export default cloudinary;