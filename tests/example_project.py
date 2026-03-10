# -*- coding: utf-8 -*-
"""
示例项目
用于测试ConsistenCy工具
"""


def calculate_sum(a, b):
    """计算两个数的和"""
    return a + b


def CalculateProduct(x, y):
    """计算两个数的积 - 注意：命名风格不一致"""
    return x * y


class UserManager:
    """用户管理器 - 使用PascalCase"""
    
    def __init__(self):
        """初始化用户管理器"""
        self.users = []
    
    def add_user(self, user):
        """添加用户"""
        self.users.append(user)
    
    def get_user(self, user_id):
        """获取用户"""
        for user in self.users:
            if user.get('id') == user_id:
                return user
        return None
    
    def remove_user(self, user_id):
        """删除用户"""
        self.users = [u for u in self.users if u.get('id') != user_id]


class database_connection:
    """数据库连接 - 注意：命名风格不一致，应该用PascalCase"""
    
    def __init__(self, host, port):
        self.host = host
        self.port = port
    
    def connect(self):
        """连接数据库"""
        print(f"连接到 {self.host}:{self.port}")
    
    def disconnect(self):
        """断开连接"""
        print("断开连接")


class DatabaseFactory:
    """数据库工厂 - 工厂模式"""
    
    @staticmethod
    def create_connection(db_type, host, port):
        """创建数据库连接"""
        if db_type == "mysql":
            return database_connection(host, port)
        elif db_type == "postgres":
            return database_connection(host, port)
        else:
            raise ValueError(f"不支持的数据库类型: {db_type}")


class Singleton:
    """单例模式示例"""
    
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance


def very_long_function_that_does_too_many_things(data):
    # 这个函数太长了，应该拆分
    result = []
    for item in data:
        if item > 0:
            processed = item * 2
            if processed > 100:
                processed = 100
            result.append(processed)
        else:
            processed = item * -1
            if processed > 50:
                processed = 50
            result.append(processed)
    
    # 更多处理
    final_result = []
    for r in result:
        if r % 2 == 0:
            final_result.append(r)
    
    # 排序
    final_result.sort()
    
    # 返回前10个
    return final_result[:10]


# 重复的函数 - 与calculate_sum功能相同
def add_numbers(x, y):
    return x + y
