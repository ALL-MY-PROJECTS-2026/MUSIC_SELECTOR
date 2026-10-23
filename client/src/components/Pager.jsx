import { useState, useEffect } from 'react';

// 목록을 세로 스크롤 대신 페이지로 나눠 보여주기 위한 공통 훅
// start: 현재 페이지 첫 항목의 전체 목록 기준 인덱스 (원래 인덱스가 필요한 핸들러용)
export function usePaging(items, pageSize) {
  const [page, setPage] = useState(1);
  const list = items || [];
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));

  // 항목이 줄어 현재 페이지가 비면 마지막 페이지로 이동
  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const start = (Math.min(page, totalPages) - 1) * pageSize;
  return { page, setPage, totalPages, start, pageItems: list.slice(start, start + pageSize) };
}

// 이전/다음 버튼 (대기열과 같은 모양). 한 페이지뿐이면 표시하지 않음
function Pager({ page, totalPages, setPage }) {
  if (totalPages <= 1) return null;

  return (
    <div className="queue-pagination pager" onClick={(e) => e.stopPropagation()}>
      <button
        className="queue-pagination-btn"
        onClick={() => setPage((prev) => Math.max(1, prev - 1))}
        disabled={page === 1}
        title="이전 페이지"
        aria-label="이전 페이지"
      >
        <span className="material-icons">chevron_left</span>
      </button>
      <span className="queue-pagination-info">
        {page} / {totalPages}
      </span>
      <button
        className="queue-pagination-btn"
        onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
        disabled={page >= totalPages}
        title="다음 페이지"
        aria-label="다음 페이지"
      >
        <span className="material-icons">chevron_right</span>
      </button>
    </div>
  );
}

export default Pager;
