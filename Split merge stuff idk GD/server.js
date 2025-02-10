const express = require('express');
const multer = require('multer');
const plist = require('plist');
const sharp = require('sharp');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Serve static files (for serving the HTML page)
app.use(express.static('public'));

// Handle file uploads for splitting
app.post('/split', upload.fields([
  { name: 'zipFile', maxCount: 1 },
  { name: 'pngFile', maxCount: 1 },
  { name: 'plistFile', maxCount: 1 }
]), async (req, res) => {
  try {
    let pngFilePath = null;
    let plistFilePath = null;
    const tempDir = fs.mkdtempSync(path.join('uploads', 'temp-')); // Create a temporary directory
    console.log(`Created temporary directory: ${tempDir}`);

    // Check if ZIP file is uploaded
    if (req.files['zipFile'] && req.files['zipFile'][0]) {
      const zipPath = req.files['zipFile'][0].path;
      console.log(`Received ZIP file: ${zipPath}`);
      const zip = new AdmZip(zipPath);
      const zipEntries = zip.getEntries();

      // Log the contents of the ZIP file
      console.log('Contents of the ZIP file:');
      zipEntries.forEach((entry) => {
        console.log(`- ${entry.entryName}`);
      });

      // Extract files from the ZIP into the temporary directory
      zip.extractAllTo(tempDir, true);
      console.log(`Extracted ZIP contents to temporary directory.`);

      // Cleanup ZIP file
      fs.unlinkSync(zipPath);
      console.log(`Deleted uploaded ZIP file: ${zipPath}`);

      // Get the list of .png and .plist files (recursive search)
      const allFiles = getAllFiles(tempDir);
      console.log('Files extracted from ZIP:');
      allFiles.forEach((file) => {
        console.log(`- ${file}`);
      });

      const pngFiles = allFiles.filter((file) => file.toLowerCase().endsWith('.png'));
      const plistFiles = allFiles.filter((file) => file.toLowerCase().endsWith('.plist') || file.toLowerCase().endsWith('.xml'));

      if (pngFiles.length === 0 || plistFiles.length === 0) {
        throw new Error('The ZIP file must contain at least one PNG and one plist/XML file.');
      }

      // Match PNG and plist files by name
      let matched = false;
      for (const pngFile of pngFiles) {
        const pngBaseName = path.basename(pngFile, path.extname(pngFile));
        for (const plistFile of plistFiles) {
          const plistBaseName = path.basename(plistFile, path.extname(plistFile));
          if (pngBaseName === plistBaseName) {
            pngFilePath = pngFile;
            plistFilePath = plistFile;
            matched = true;
            console.log(`Matched PNG and plist files: ${pngFilePath}, ${plistFilePath}`);
            break;
          }
        }
        if (matched) break;
      }

      if (!matched) {
        throw new Error('No matching PNG and plist files found in the ZIP. They must have the same base name.');
      }
    } else {
      // Check for individual PNG and plist files
      if (req.files['pngFile'] && req.files['pngFile'][0]) {
        pngFilePath = req.files['pngFile'][0].path;
      }
      if (req.files['plistFile'] && req.files['plistFile'][0]) {
        plistFilePath = req.files['plistFile'][0].path;
      }

      if (!pngFilePath || !plistFilePath) {
        throw new Error('Both PNG and plist files are required.');
      }

      // Check if the base names match
      const pngBaseName = path.basename(req.files['pngFile'][0].originalname, '.png');
      const plistBaseName = path.basename(req.files['plistFile'][0].originalname, path.extname(req.files['plistFile'][0].originalname));
      if (pngBaseName !== plistBaseName) {
        throw new Error('The PNG and plist files must have the same base name.');
      }
    }

    // Read and parse the plist file
    console.log(`Reading plist file: ${plistFilePath}`);
    const plistData = fs.readFileSync(plistFilePath, 'utf8');
    const plistJson = plist.parse(plistData);

    if (!plistJson.frames) {
      throw new Error('No frames found in plist file.');
    }

    // Read the sprite sheet image
    console.log(`Reading sprite sheet image: ${pngFilePath}`);
    const spriteSheetBuffer = fs.readFileSync(pngFilePath);

    // Create a ZIP archive to hold the extracted sprites
    const outputZip = new AdmZip();

    // Process each frame
    const frames = plistJson.frames;
    const frameNames = Object.keys(frames);
    console.log(`Processing ${frameNames.length} frames...`);

    for (const frameName of frameNames) {
      const frame = frames[frameName];
      const frameInfo = parseFrameData(frame);

      if (!frameInfo) {
        console.warn(`Skipping frame ${frameName} due to invalid data.`);
        continue;
      }

      // Extract the sprite using sharp
      let spriteBuffer;
      if (frameInfo.rotated) {
        // Handle rotated frames
        spriteBuffer = await extractRotatedFrame(spriteSheetBuffer, frameInfo);
      } else {
        // Handle regular frames
        spriteBuffer = await sharp(spriteSheetBuffer)
          .extract({
            left: frameInfo.x,
            top: frameInfo.y,
            width: frameInfo.width,
            height: frameInfo.height
          })
          .toBuffer();
      }

      // Add the sprite to the ZIP archive
      outputZip.addFile(`${frameName}.png`, spriteBuffer);
    }

    // Generate the ZIP and send it to the client
    const zipBuffer = outputZip.toBuffer();

    // Cleanup uploaded files and temporary directory
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`Deleted temporary directory: ${tempDir}`);
    if (req.files['pngFile']) {
      fs.unlinkSync(pngFilePath);
      console.log(`Deleted uploaded PNG file: ${pngFilePath}`);
    }
    if (req.files['plistFile']) {
      fs.unlinkSync(plistFilePath);
      console.log(`Deleted uploaded plist file: ${plistFilePath}`);
    }

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="extracted_sprites.zip"');
    res.send(zipBuffer);
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).send('Error processing files: ' + error.message);
  }
});

// Function to parse frame data from the plist
function parseFrameData(frame) {
  try {
    let frameRect = frame.frame;
    let rotated = frame.rotated || false;
    let sourceSize = frame.sourceSize || { width: frame.width, height: frame.height };
    let offset = frame.offset || { x: 0, y: 0 };

    // Process frameRect
    if (typeof frameRect === 'string') {
      // Remove braces and spaces
      frameRect = frameRect.replace(/[{} ]/g, '');
      const parts = frameRect.split(',');
      const x = parseInt(parts[0], 10);
      const y = parseInt(parts[1], 10);
      const width = parseInt(parts[2], 10);
      const height = parseInt(parts[3], 10);

      // Parse offset if available
      if (typeof offset === 'string') {
        offset = offset.replace(/[{} ]/g, '').split(',');
        offset = { x: parseInt(offset[0], 10), y: parseInt(offset[1], 10) };
      }

      return { x, y, width, height, rotated, offset, sourceSize };
    } else if (typeof frameRect === 'object') {
      // If the frame data is already an object
      const { x, y, w, h } = frameRect;
      return { x, y, width: w, height: h, rotated, offset, sourceSize };
    } else {
      return null;
    }
  } catch (error) {
    console.error('Error parsing frame data:', error.message);
    return null;
  }
}

// Function to extract rotated frames
async function extractRotatedFrame(spriteSheetBuffer, frameInfo) {
  // Extract the rotated portion
  const extractedBuffer = await sharp(spriteSheetBuffer)
    .extract({
      left: frameInfo.x,
      top: frameInfo.y,
      width: frameInfo.height, // Note: swap width and height for rotation
      height: frameInfo.width
    })
    .toBuffer();

  // Rotate the extracted image
  const rotatedBuffer = await sharp(extractedBuffer)
    .rotate(-90)
    .toBuffer();

  // If trimming is needed, apply offset and sourceSize

  return rotatedBuffer;
}

// Recursive function to get all files in a directory
function getAllFiles(dirPath, arrayOfFiles) {
  files = fs.readdirSync(dirPath);

  arrayOfFiles = arrayOfFiles || [];

  files.forEach(function (file) {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
    } else {
      arrayOfFiles.push(fullPath);
    }
  });

  return arrayOfFiles;
}

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});