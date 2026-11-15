# FORGE CNC

## Chạy ứng dụng

Yêu cầu Node.js 22.5 trở lên.

Cài phụ thuộc một lần bằng `npm.cmd install`, sau đó chạy `npm.cmd start` trong thư mục dự án. Ứng dụng tự đọc biến môi trường trong `.env`. Mặc định dùng SQLite tại `data/forge.sqlite`; cấu hình Firebase Firestore hoặc MongoDB sẽ chuyển máy chủ sang kho dữ liệu cloud tương ứng. Máy chủ không âm thầm quay về SQLite nếu kết nối cloud lỗi.

Ứng dụng có thể tự khởi động máy chủ khi đăng nhập Windows. Thiết lập một lần bằng PowerShell:

```powershell
$startup = [Environment]::GetFolderPath('Startup')
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup 'FORGE CNC Server.lnk'))
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments = '"D:\Vs_Code\Web_CNC\start-server-hidden.vbs"'
$shortcut.WorkingDirectory = 'D:\Vs_Code\Web_CNC'
$shortcut.Save()
```

Sau đó mở `http://127.0.0.1:3000` trong trình duyệt. Máy chủ chạy ẩn sau khi đăng nhập; nếu ứng dụng đã chạy thì trình khởi động sẽ không mở thêm máy chủ. Cách thủ công khi cần là mở terminal tại thư mục `Web_CNC` rồi chạy `npm.cmd start`.

Không mở trực tiếp `index.html`. Dữ liệu chỉ được tải và lưu qua máy chủ Node.js.

## Lưu trữ dữ liệu

Dữ liệu kế hoạch, tiến độ CNC/Taro/Gọt via, nhập kho nhôm, phiếu bàn giao, định mức, phân bổ máy, tài khoản và phiên đăng nhập được lưu trong một trong ba nơi: SQLite cục bộ, Firebase Cloud Firestore hoặc MongoDB Atlas. Chỉ cấu hình một kho cloud tại một thời điểm; Firestore được chọn khi có `FIREBASE_PROJECT_ID`, `GOOGLE_APPLICATION_CREDENTIALS` hoặc `FIREBASE_SERVICE_ACCOUNT_JSON`. Ở chế độ cloud, SQLite không phải bản dự phòng tự động.

Để chuyển dữ liệu SQLite hiện có sang Firestore, cấu hình Firebase trong `.env` rồi chạy `npm.cmd run migrate:firebase`. Script chỉ ghi khi Firestore chưa có trạng thái ứng dụng hoặc tài khoản, không sửa/xóa SQLite, và không chuyển phiên đăng nhập hiện tại; người dùng cần đăng nhập lại. Nếu Firestore đã có dữ liệu, script dừng mà không ghi đè. Giữ nguyên SQLite làm bản quay lui đến khi xác nhận dữ liệu cloud đầy đủ.

Không đưa file khóa tài khoản dịch vụ hoặc nội dung `FIREBASE_SERVICE_ACCOUNT_JSON` vào Git hay gửi qua chat. Với máy cục bộ, đặt file khóa ngoài thư mục dự án rồi cấu hình `FIREBASE_PROJECT_ID` và `GOOGLE_APPLICATION_CREDENTIALS` trong `.env`. Với host cloud, dùng Secret File/secret environment variables. Firestore Rules mặc định có thể giữ ở chế độ khóa; máy chủ dùng Firebase Admin SDK và xác thực bằng tài khoản dịch vụ, không dùng khóa bí mật trong trình duyệt. Tài khoản dịch vụ cần quyền Firestore đọc/ghi, ví dụ vai trò `Cloud Datastore User`.

Thiết lập Firebase lần đầu:

1. Trong Firebase Console, tạo Cloud Firestore ở **Production mode**. Chọn vị trí gần máy chủ/người dùng; vị trí cơ sở dữ liệu không đổi được sau khi tạo.
2. Trong **Project settings → Service accounts**, tạo khóa JSON cho Firebase Admin SDK. Lưu khóa ngoài thư mục dự án.
3. Sao chép `.env.example` thành `.env`; điền `FIREBASE_PROJECT_ID` và `GOOGLE_APPLICATION_CREDENTIALS` (đường dẫn đến file khóa). Để `MONGODB_URI` trống.
4. Chạy `npm.cmd run migrate:firebase` để sao chép dữ liệu SQLite hiện tại; sau đó khởi động lại ứng dụng và kiểm tra `/api/health` có `storageMode: "firestore"`.

Không cấu hình đồng thời `MONGODB_URI` và Firebase. Muốn dùng Atlas, đặt `MONGODB_URI` và tùy chọn `MONGODB_DB`; chuyển SQLite lên Atlas bằng `npm.cmd run migrate:atlas`. Cả hai lệnh migration đều không ghi đè đích đã có dữ liệu.

Render Free phù hợp chạy thử: dịch vụ ngủ sau 15 phút không có truy cập, lần mở tiếp theo có thể mất khoảng một phút; hệ thống tệp cục bộ không bền. Vì vậy dữ liệu phải ở Atlas, không phải SQLite trên Render. Gói Free không có cam kết vận hành sản xuất; xem [giới hạn Render Free](https://render.com/docs/free). MongoDB Atlas M0 miễn phí 512 MB và phù hợp thử nghiệm; xem [bảng giá MongoDB Atlas](https://www.mongodb.com/pricing).

## Tài khoản và quyền truy cập

Người dùng tạo tài khoản bằng email/mật khẩu (mật khẩu tối thiểu 8 ký tự). Theo lựa chọn hiện tại, đăng ký mở và không xác minh email: mọi tài khoản tạo được đều có thể xem toàn bộ kế hoạch, tồn kho và lịch sử bàn giao. Người xem không thể ghi dữ liệu qua API; muốn sửa phải gửi yêu cầu, quản trị viên duyệt trong **Quản lý quyền**. Máy chủ kiểm tra vai trò trước khi cho phép ghi.

Email quản trị viên đầu tiên mặc định là email đã cấu hình trong máy chủ (`ADMIN_EMAIL`). Người này cần mã thiết lập một lần: trên máy cục bộ mã được điền tự động; trên host cloud, mã ngẫu nhiên hiển thị trong log riêng của dịch vụ. Không chia sẻ mã này. Sau khi tạo quản trị viên đầu tiên, tài khoản quản trị có thể duyệt hoặc thu hồi quyền sửa cho người khác. Có thể đặt `ADMIN_BOOTSTRAP_CODE` trong biến môi trường để dùng mã ổn định trong lần thiết lập.

Biểu mẫu đăng nhập/đăng ký bật các thuộc tính `autocomplete` để trình quản lý mật khẩu của trình duyệt có thể đề xuất lưu và tự điền thông tin. Ứng dụng không lưu mật khẩu dạng chữ thường và không tự bật hộp thoại lưu của trình duyệt; hộp thoại này tùy thuộc vào trình duyệt và cài đặt người dùng.

Nút hình con mắt cạnh ô mật khẩu dùng để hiện/ẩn nội dung mật khẩu hoặc mã thiết lập; trạng thái mặc định luôn được che.

Trang **Máy CNC** hiển thị danh sách chi tiết phân công cho bốn máy theo cùng một bảng; mỗi máy hiện trước năm chi tiết và có thể mở rộng/thu gọn phần còn lại. Cột thời gian chạy một chi tiết và ghi chú để trống khi chưa có dữ liệu. Dòng 14 và 41 trùng linh kiện/máy được gộp thành một mục; ô phân bổ sản phẩm theo kế hoạch được lưu cùng dữ liệu sản xuất.

Các thay đổi số lượng CNC, Taro, Gọt via và ghi chú trong chi tiết kế hoạch là bản nháp cho đến khi nhấn **Cập nhật dữ liệu**. Có thể sửa nhiều dòng rồi lưu một lần; số lượng hoàn thành không thể vượt quá dự định. Nút **MAX** điền nhanh số dự định cho một dòng; **MAX TẤT CẢ** điền số dự định cho mọi chi tiết CNC của sản phẩm đang mở. Cả hai thao tác chỉ tạo bản nháp, cần nhấn **Cập nhật dữ liệu** để lưu. Tổng kế hoạch được tính theo **bộ**. Ứng dụng sẽ cảnh báo nếu đóng hoặc tải lại trang khi còn thay đổi chưa lưu.

Trong **Lịch sử bàn giao**, chọn **Tải phiếu Word (.docx)** để xuất phiếu có thông tin người giao/nhận và danh sách chi tiết theo đúng ảnh chụp dữ liệu lúc bàn giao. Có thể xóa riêng từng phiếu; thao tác xác nhận sẽ trả số lượng về khả dụng trong kho chi tiết và mở khóa kế hoạch liên quan, không xóa toàn bộ lịch sử.

Logo trên thanh đầu trang dùng `File_Anh_WebCNC/Logo_Delta_X.jpg`. Trong **Sản phẩm & chi tiết**, thẻ sản phẩm hiển thị ảnh máy; mở từng thẻ để xem tên linh kiện, loại phôi, định mức, cấu hình áp dụng và ảnh chi tiết đã ghép. Ảnh được phục vụ từ thư mục `File_Anh_WebCNC`; chi tiết chưa có ảnh phù hợp vẫn hiện khung chờ. BOM X3 được bổ sung theo bảng; BOM Băng tải XS gồm đúng ba dòng: Gá nhôm băng tải XS, Bánh răng sắt và Tấm gá Sắt.

Không dùng chế độ mở `index.html` bằng `file://`; đăng nhập cần được thực hiện qua máy chủ cùng origin. Nếu bản dữ liệu cũ chỉ còn trong localStorage của một trình duyệt, giữ nguyên trình duyệt đó và tạo bản sao trước khi chuyển đổi; không ghi đè dữ liệu SQLite/Atlas hiện có.

Muốn sao lưu SQLite, hãy dừng máy chủ trước rồi mới sao chép `data/forge.sqlite`; không sao chép riêng `forge.sqlite-wal` vì đó không phải bản sao dữ liệu độc lập. Không xóa thư mục `data` nếu muốn giữ bản cục bộ.
