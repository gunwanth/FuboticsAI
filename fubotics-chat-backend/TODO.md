# TODO: Add Data Analytics Features to Backend

## Steps to Complete

- [x] Update package.json to add new dependencies: multer, csv-parser, @json2csv/node
- [x] Edit index.js to add multer middleware with file size limits (50MB) and upload limits (max 5 files)
- [x] Add new route: POST /api/upload-data (protected) - Handle file upload, process CSV (clean data, compute stats), generate cleaned CSV and JSON report
- [x] Add new route: GET /api/download/:filename (protected) - Serve generated files for download
- [x] Create 'uploads' and 'generated' directories if not exist
- [x] Install new dependencies via npm install
- [ ] Test file upload and processing functionality
- [x] Ensure auth protection on new routes
