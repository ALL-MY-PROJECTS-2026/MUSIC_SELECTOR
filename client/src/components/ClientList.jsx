import React, { useState, useEffect } from 'react';
import './ClientList.css';

function ClientList({ socket, isAdmin, hasControl }) {
  const [clients, setClients] = useState([]);

  useEffect(() => {
    if (!socket || !isAdmin) return;

    // 클라이언트 목록 요청
    const requestClientList = () => {
      socket.emit('getClientList');
    };

    // 클라이언트 목록 수신
    const handleClientList = (clientList) => {
      setClients(clientList);
    };

    socket.on('clientList', handleClientList);
    
    // 초기 요청
    requestClientList();
    
    // 주기적으로 업데이트 (5초마다)
    const interval = setInterval(requestClientList, 5000);

    return () => {
      socket.off('clientList', handleClientList);
      clearInterval(interval);
    };
  }, [socket, isAdmin]);

  const handleDisconnect = (socketId) => {
    if (window.confirm('이 클라이언트의 연결을 해제하시겠습니까?')) {
      socket.emit('disconnectClient', socketId);
    }
  };

  const handleDisconnectAll = () => {
    // 제어권이 있는 세션을 제외한 모든 클라이언트 (관리자 포함)
    const otherClientsCount = clients.filter(c => !c.hasControl).length;
    if (otherClientsCount === 0) {
      alert('해제할 클라이언트가 없습니다.');
      return;
    }
    
    const adminCount = clients.filter(c => !c.hasControl && c.isAdmin).length;
    const userCount = clients.filter(c => !c.hasControl && !c.isAdmin).length;
    
    let confirmMessage = `제어권이 있는 세션을 제외한 모든 연결을 해제하시겠습니까?\n\n`;
    confirmMessage += `총 ${otherClientsCount}개의 연결이 해제됩니다.`;
    if (adminCount > 0) {
      confirmMessage += `\n(관리자 세션 ${adminCount}개 포함, 사용자 ${userCount}개)`;
    }
    confirmMessage += `\n\n제어권이 있는 세션만 남게 됩니다.`;
    
    if (window.confirm(confirmMessage)) {
      socket.emit('disconnectAllExceptController');
    }
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleString('ko-KR');
  };

  if (!isAdmin) {
    return null;
  }

  return (
    <div className="client-list">
      <div className="client-list-header">
        <h2>연결된 클라이언트 ({clients.length})</h2>
        {hasControl && clients.length > 1 && (
          <button onClick={handleDisconnectAll} className="disconnect-all-btn">
            일괄 해제
          </button>
        )}
      </div>
      {clients.length === 0 ? (
        <div className="empty-clients">
          <p>연결된 클라이언트가 없습니다.</p>
        </div>
      ) : (
        <div className="clients-items">
          {clients.map((client) => (
            <div key={client.socketId} className="client-item">
              <div className="client-info">
                <div className="client-header">
                  <span className={`client-admin-badge ${client.isAdmin ? 'admin' : 'user'}`}>
                    {client.isAdmin ? '관리자' : '사용자'}
                  </span>
                  <span className="client-id">{client.socketId.slice(0, 8)}...</span>
                </div>
                <div className="client-details">
                  <p className="client-ip">IP: {client.ip || '알 수 없음'}</p>
                  <p className="client-host">Host: {client.host || '알 수 없음'}</p>
                  <p className="client-time">연결 시간: {formatDate(client.connectedAt)}</p>
                  <p className="client-user-agent">User Agent: {client.userAgent.substring(0, 50)}...</p>
                </div>
              </div>
              {!client.isAdmin && (
                <button 
                  onClick={() => handleDisconnect(client.socketId)}
                  className="disconnect-btn"
                  title="연결 해제"
                >
                  연결 해제
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ClientList;

