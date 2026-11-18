# FORGE CNC

## Chạy ứng dụng

Yêu cầu Node.js 22.5 trở lên.

Cài phụ thuộc một lần bằng `npm.cmd install`, sau đó chạy `npm.cmd start` trong thư mục dự án. Ứng dụng tự đọc biến môi trường từ `.env`. Mở `http://127.0.0.1:3000`; không mở trực tiếp `index.html`.

Các phân hệ có URL riêng dạng hash: `http://127.0.0.1:3000/#/dashboard`, `#/plans`, `#/inventory`, `#/products` và `#/machines`. Có thể mở trực tiếp, tải lại hoặc chia sẻ các URL này; nút Back/Forward của trình duyệt cũng chuyển giữa các phân hệ.

Máy chủ có thể tự khởi động ẩn khi đăng nhập Windows. Thiết lập một lần bằng PowerShell:

```powershell
$startup = [Environment]::GetFolderPath('Startup')
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup 'FORGE CNC Server.lnk'))
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments = '"D:\Vs_Code\Web_CNC\start-server-hidden.vbs"'
$shortcut.WorkingDirectory = 'D:\Vs_Code\Web_CNC'
$shortcut.Save()
```

Nếu máy chủ đã chạy, không cần khởi động thêm bản thứ hai. Nếu cổng 3000 đang bận, dừng máy chủ cũ bằng `Ctrl+C` trước khi chạy lại.

## Cấu trúc mã nguồn

- `index.html`: khung trang và điểm nạp tài nguyên.
- `assets/css/app.css`: giao diện và kiểu dùng chung.
- `assets/js/config.js`: BOM, danh mục sản phẩm, ảnh và cấu hình máy.
- `assets/js/state.js`: trạng thái ứng dụng và đọc/ghi Firebase.
- `assets/js/app.js`: điều hướng, khung trang và khởi tạo ứng dụng.
- `assets/js/pages/`: mã riêng cho Dashboard, Kế hoạch, Kho, Sản phẩm và Máy CNC.
- `server.mjs`: phục vụ trang, tài nguyên tĩnh và API Firestore.

## Firebase Firestore

Ứng dụng chỉ sử dụng Firebase Cloud Firestore. Tạo `.env` từ `.env.example`, rồi cấu hình `FIREBASE_PROJECT_ID` và `GOOGLE_APPLICATION_CREDENTIALS` trỏ đến file khóa service account được lưu ngoài thư mục dự án. Có thể dùng `FIREBASE_SERVICE_ACCOUNT_JSON` thay cho đường dẫn file. Máy chủ cần quyền đọc/ghi Firestore; Firebase Admin SDK chạy ở máy chủ, không đưa khóa vào trình duyệt.

Trạng thái ứng dụng hiện được lưu trong document `app_state/main`, cùng revision và thời gian cập nhật. Dữ liệu này được ghi dưới dạng JSON trong trường `payload`. Ứng dụng kiểm tra revision trước khi ghi để tránh ghi đè thay đổi mới hơn từ thiết bị khác.

Thư mục `data` có thể còn bản SQLite cũ; phiên bản này không đọc hoặc cập nhật bản đó. Giữ nguyên thư mục này làm bản lưu cho tới khi chắc chắn không cần khôi phục dữ liệu cũ.

## Quyền truy cập và dữ liệu

Đăng nhập và tạo tài khoản đã được gỡ. Bất kỳ ai có đường dẫn ứng dụng đều có thể xem, sửa và xóa dữ liệu; chỉ chia sẻ đường dẫn với người đáng tin cậy. Các collection tài khoản cũ trên Firestore không được phiên bản này sử dụng hoặc tự động xóa.

Kế hoạch, tiến độ CNC/Taro/Gọt via, nhập kho nhôm, phiếu bàn giao, định mức và phân bổ máy CNC được lưu chung trong trạng thái ứng dụng. Các thay đổi trong bảng chi tiết kế hoạch là bản nháp cho tới khi nhấn **Cập nhật dữ liệu**. Số lượng hoàn thành không được vượt quá dự định; các nút **MAX** chỉ điền bản nháp.

Trong **Lịch sử bàn giao**, có thể tải phiếu Word và xóa riêng từng phiếu. Xóa phiếu sẽ trả số lượng về kho chi tiết khả dụng và mở khóa kế hoạch liên quan.

Ảnh sản phẩm được phục vụ từ `File_Anh_WebCNC`. Không xóa thư mục ảnh nếu còn sử dụng thư viện sản phẩm.
